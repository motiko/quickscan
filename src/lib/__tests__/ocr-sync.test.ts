import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { OcrResult } from '@/lib/ocr';

/*
 * The OCR queue and sync together: what a local recognition may write on a page or document
 * that another device changed.
 */

vi.mock('@/lib/ocr', () => ({ recognize: vi.fn() }));
vi.mock('@/lib/image-processing', () => ({
  // A "rotated" image is the original's text plus the turn, so a turn shows in the bytes
  rotateImage: vi.fn(async (blob: Blob, degrees: number) => new Blob([`${await blob.text()}@${degrees}`])),
  createThumbnail: vi.fn(async () => new Blob(['thumb'])),
}));
vi.mock('@/lib/annotations/flatten', () => ({
  getImageSize: vi.fn(async () => ({ width: 600, height: 800 })),
  getRenderedBlob: vi.fn(async (page: { processedBlob?: Blob }) => page.processedBlob),
}));

import { db } from '@/lib/db';
import { recognize } from '@/lib/ocr';
import { processPendingOcr } from '@/lib/ocr-queue';
import { createDocument } from '@/hooks/useDocuments';
import { getDeviceId, readOutbox } from '@/lib/outbox';
import { decryptRecord, generateVaultKey, type VaultKey } from '@/lib/crypto';
import { createSupabaseBackend } from '@/lib/sync/backend';
import { runSync, type SyncContext } from '@/lib/sync/engine';
import { RetryTracker } from '@/lib/sync/state';
import { FakeSupabase } from './fake-supabase';

const USER = '00000000-0000-4000-8000-00000000000a';
const word = (text: string, confidence: number) => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
const upright: OcrResult = {
  text: 'Invoice 2026-0042 Total amount due 553.95',
  confidence: 94,
  words: ['Invoice', '2026-0042', 'Total', 'amount', 'due', '553.95'].map((t) => word(t, 95)),
};
const upsideDown: OcrResult = {
  text: '*a]ep 92I0AUl BY} JO SAep',
  confidence: 26,
  words: [word('*a]ep', 30), word('92I0AUl', 40), word('JO', 75), word('SAep', 20)],
};

let vault: VaultKey;

async function context(server: FakeSupabase): Promise<SyncContext> {
  return {
    backend: createSupabaseBackend(server.asClient()),
    userId: server.userId,
    vault,
    deviceId: await getDeviceId(),
    now: () => Date.now(),
    retry: new RetryTracker(),
  };
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  vault = { key: await generateVaultKey(), keyVersion: 1 };
  // Every image reads upside down; only a 180° turn of it reads upright
  vi.mocked(recognize).mockReset();
  vi.mocked(recognize).mockImplementation(async (b: Blob) => ((await b.text()).endsWith('@180') ? upright : upsideDown));
});

describe('OCR and sync', () => {
  it('does not turn another device’s image that downloads while the capture is still waiting for OCR', async () => {
    const server = new FakeSupabase(USER);
    const docId = await createDocument('Scan', new Blob(['mine'], { type: 'image/jpeg' }));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    const ctx = await context(server);
    await runSync(ctx);

    // Another device turned the page by hand; the capture here hasn't been recognized yet
    const path = await server.remoteFile(vault.key, 'file-2', new Blob(['theirs'], { type: 'image/jpeg' }));
    await server.remoteRecord(vault.key, {
      kind: 'page',
      id: page.id,
      updatedAt: server.get('page', page.id)!.updatedAt + 1000,
      value: { documentId: docId, pageNumber: 1, filter: 'original', createdAt: page.createdAt, file: { id: 'file-2', type: 'image/jpeg' } },
      files: [path],
    });
    await runSync(ctx);
    const pulled = await db.pages.get(page.id);
    expect(await pulled!.processedBlob!.text()).toBe('theirs');
    expect(pulled!.originalBlob).toBeDefined();
    expect(pulled!.ocrStatus).toBe('pending');

    await processPendingOcr();

    const after = await db.pages.get(page.id);
    expect(await after!.processedBlob!.text()).toBe('theirs');
    expect(after!.ocrText).toBe(upsideDown.text);
    // Only the recognized text goes back, not a new image
    expect(await readOutbox()).toEqual([expect.objectContaining({ kind: 'page', id: page.id, fileChanged: false })]);
  });

  it('keeps a rename from another device when OCR finishes here before the pull', async () => {
    const server = new FakeSupabase(USER);
    const docId = await createDocument('Scan', new Blob(['mine'], { type: 'image/jpeg' }));
    const ctx = await context(server);
    await runSync(ctx);

    // Another device renames the document just after our push...
    const doc = (await db.documents.get(docId))!;
    await server.remoteRecord(vault.key, {
      kind: 'document',
      id: docId,
      updatedAt: server.get('document', docId)!.updatedAt + 1,
      value: { name: 'Their name', nameSource: 'user', createdAt: doc.createdAt, updatedAt: doc.updatedAt },
    });
    // ...and later, before the next pull, recognition here updates the search text
    await new Promise((r) => setTimeout(r, 5));
    await processPendingOcr();
    expect((await db.documents.get(docId))!.searchText).toBe(upright.text.toLowerCase());
    expect((await readOutbox()).filter((e) => e.kind === 'document')).toEqual([]);

    await runSync(ctx);

    expect(await db.documents.get(docId)).toMatchObject({ name: 'Their name', searchText: upright.text.toLowerCase() });
    const row = server.get('document', docId)!;
    const remote = await decryptRecord<{ name: string }>(vault.key, { userId: USER, kind: 'document', id: docId }, row.payload!, {
      deviceId: row.deviceId,
      deleted: row.deleted,
    });
    expect(remote.name).toBe('Their name');
  });
});
