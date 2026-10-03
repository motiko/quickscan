import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import { createDocument, addPageToDocument, deleteDocument, renameDocument, savePageAnnotations, updatePage } from '@/hooks/useDocuments';
import { createFolder } from '@/lib/folders';
import { updateSettings } from '@/lib/settings';
import { getDeviceId, readOutbox } from '@/lib/outbox';
import { decryptFile, decryptRecord, generateVaultKey, type VaultKey } from '@/lib/crypto';
import { createSupabaseBackend } from '@/lib/sync/backend';
import { compareClock, runSync, SyncError, type SyncContext } from '@/lib/sync/engine';
import { withSyncLock, SYNC_LOCK_NAME } from '@/lib/sync/lock';
import { getCursor, getFileRef, RetryTracker, cursorKey } from '@/lib/sync/state';
import { chooseUploadToAccount } from '@/lib/sync/account-switch';
import { FakeSupabase } from './fake-supabase';
import type { Page } from '@/types';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

let vault: VaultKey;
let clock: number;

const img = (s: string, type = 'image/jpeg') => new Blob([s], { type });
const text = (b: Blob) => b.text();

async function context(server: FakeSupabase, overrides: Partial<SyncContext> = {}): Promise<SyncContext> {
  return {
    backend: createSupabaseBackend(server.asClient()),
    userId: server.userId,
    vault,
    deviceId: await getDeviceId(),
    now: () => clock,
    retry: new RetryTracker(),
    ...overrides,
  };
}

async function decrypted<T = Record<string, unknown>>(server: FakeSupabase, kind: string, id: string): Promise<T> {
  const row = server.get(kind as never, id)!;
  return decryptRecord<T>(vault.key, { userId: server.userId, kind, id }, row.payload!, {
    deviceId: row.deviceId,
    deleted: row.deleted,
  });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  vault = { key: await generateVaultKey(), keyVersion: 1 };
  clock = Date.now();
});

describe('compareClock', () => {
  it('orders by time, then device id bytewise', () => {
    expect(compareClock(2, 'a', 1, 'z')).toBe(1);
    expect(compareClock(1, 'B', 1, 'a')).toBe(-1); // 'B' < 'a' in C collation
    expect(compareClock(1, 'a', 1, 'a')).toBe(0);
  });
});

describe('push', () => {
  it('pushes encrypted records and files, then acks the outbox', async () => {
    const server = new FakeSupabase(USER_A);
    const folderId = await createFolder('Taxes');
    const docId = await createDocument('Invoice ACME', img('page-1'));
    await db.documents.update(docId, { folderId, tags: ['work'] });
    await updateSettings({ ocrLanguages: ['eng', 'deu'] });
    const [page] = await db.pages.where('documentId').equals(docId).toArray();

    const report = await runSync(await context(server));

    expect(report.issues).toEqual([]);
    expect(report.uploads).toBe(1);
    expect(await readOutbox()).toEqual([]);

    const doc = await decrypted(server, 'document', docId);
    expect(doc).toMatchObject({ name: 'Invoice ACME', folderId, tags: ['work'], nameSource: 'default' });
    // Derived and local-only fields stay home
    expect(doc).not.toHaveProperty('thumbnailBlob');
    expect(doc).not.toHaveProperty('pageCount');
    expect(doc).not.toHaveProperty('searchText');

    const pagePayload = await decrypted<{ file: { id: string; type: string }; documentId: string }>(server, 'page', page.id);
    expect(pagePayload.documentId).toBe(docId);
    expect(pagePayload).not.toHaveProperty('originalBlob');
    expect(pagePayload).not.toHaveProperty('ocrStatus');
    expect(pagePayload.file.type).toBe('image/jpeg');
    const path = `${USER_A}/${pagePayload.file.id}`;
    expect(server.get('page', page.id)!.files).toEqual([path]);
    const file = await decryptFile(vault.key, { userId: USER_A, fileId: pagePayload.file.id }, server.objects.get(path)!);
    expect(await text(file)).toBe('page-1');

    expect(await decrypted(server, 'folder', folderId)).toMatchObject({ name: 'Taxes' });
    expect(await decrypted(server, 'settings', 'ocrLanguages')).toEqual({ value: ['eng', 'deu'] });
    // Unsynced settings never leave
    expect(server.get('settings', 'llmProvider')).toBeUndefined();
  });

  it('sends no plaintext: names and file bytes are ciphertext', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Secret Medical Report', img('PIXELS-PLAINTEXT'));
    await runSync(await context(server));
    const row = server.get('document', docId)!;
    expect(new TextDecoder().decode(row.payload!)).not.toContain('Secret');
    for (const blob of server.objects.values()) expect(await text(blob)).not.toContain('PIXELS');
  });

  it('pushes the outbox clock as updated_at and deletes as tombstones', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Doc', img('x'));
    const [entry] = (await readOutbox()).filter((e) => e.kind === 'document');
    await runSync(await context(server));
    expect(server.get('document', docId)!.updatedAt).toBe(entry.updatedAt);

    await deleteDocument(docId);
    await runSync(await context(server));
    expect(server.get('document', docId)).toMatchObject({ deleted: true, payload: null, files: [] });
    expect(await readOutbox()).toEqual([]);
  });

  it('settles a push that loses to a version written after the pull', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Local name', img('x'));
    const ctx = await context(server);
    await runSync(ctx); // the first sync (a merge) is done
    await renameDocument(docId, 'Local rename');
    const local = await db.documents.get(docId);
    // Another device writes between this device's pull and its push
    server.beforeUpsert = () =>
      server.remoteRecord(vault.key, {
        kind: 'document',
        id: docId,
        updatedAt: Date.now() + 60_000,
        value: { name: 'Remote name', createdAt: local!.createdAt, updatedAt: local!.updatedAt },
      });

    const report = await runSync(await context(server));
    expect(report.rejected).toBe(1);
    expect(report.conflicts).toEqual([{ kind: 'document', id: docId, loser: 'local' }]);
    expect((await readOutbox()).find((e) => e.kind === 'document')).toBeUndefined();
    expect((await db.documents.get(docId))!.name).toBe('Remote name');
    expect(server.get('document', docId)!.deviceId).toBe('other-device');
  });

  it('pushes in batches of at most 500 rows', async () => {
    const server = new FakeSupabase(USER_A);
    await db.folders.bulkAdd(
      Array.from({ length: 501 }, (_, i) => ({ id: `f${i}`, name: `F${i}`, createdAt: new Date(), updatedAt: new Date() }))
    );
    await runSync(await context(server));
    expect(server.log.filter((l) => l === 'rpc:upsert_records')).toHaveLength(2);
    expect(await readOutbox()).toEqual([]);
  });
});

describe('files', () => {
  it('uploads a file once per change', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Doc', img('v1'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    const ctx = await context(server);
    await runSync(ctx);
    expect(server.objects.size).toBe(1);
    const first = await getFileRef('page', page.id);

    await renameDocument(docId, 'Renamed');
    await savePageAnnotations(page.id, [{ id: 'a', type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, color: '#f00', width: 0.01 }]);
    await runSync(ctx);
    expect(server.objects.size).toBe(1);

    // Same bytes written again (fileChanged), still no new upload
    await updatePage(page.id, { processedBlob: img('v1') });
    await runSync(ctx);
    expect(server.objects.size).toBe(1);
    expect((await getFileRef('page', page.id))!.fileId).toBe(first!.fileId);

    await updatePage(page.id, { processedBlob: img('v2') });
    await runSync(ctx);
    expect(server.objects.size).toBe(2);
    const second = await getFileRef('page', page.id);
    expect(second!.fileId).not.toBe(first!.fileId);
    const payload = await decrypted<{ file: { id: string } }>(server, 'page', page.id);
    expect(payload.file.id).toBe(second!.fileId);
  });

  it('keeps a record whose upload failed in the outbox and retries with backoff', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Doc', img('v1'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    server.failUploads = 1;
    const ctx = await context(server);

    const report = await runSync(ctx);
    expect(report.issues).toEqual([expect.objectContaining({ stage: 'upload', kind: 'page', id: page.id })]);
    expect((await readOutbox()).map((e) => e.kind)).toEqual(['page']);
    expect(server.get('page', page.id)).toBeUndefined();
    expect(server.get('document', docId)).toBeDefined();

    // Still backing off: not tried again
    await runSync(ctx);
    expect(server.log.filter((l) => l.startsWith('upload:'))).toHaveLength(1);

    clock += 10_000;
    await runSync(ctx);
    expect(await readOutbox()).toEqual([]);
    expect(server.get('page', page.id)!.files).toHaveLength(1);
  });

  it('downloads pulled images lazily and rebuilds the thumbnail', async () => {
    const server = new FakeSupabase(USER_A);
    const now = new Date();
    await server.remoteRecord(vault.key, {
      kind: 'document',
      id: 'd1',
      updatedAt: now.getTime(),
      value: { name: 'From phone', createdAt: now, updatedAt: now },
    });
    const path = await server.remoteFile(vault.key, 'file-1', img('remote-pixels', 'image/png'));
    await server.remoteRecord(vault.key, {
      kind: 'page',
      id: 'p1',
      updatedAt: now.getTime(),
      value: {
        documentId: 'd1',
        pageNumber: 1,
        filter: 'original',
        createdAt: now,
        ocrText: 'Hello',
        file: { id: 'file-1', type: 'image/png' },
      },
      files: [path],
    });
    // The image isn't there on the first try
    const stored = server.objects.get(path)!;
    server.objects.delete(path);
    const makeThumbnail = vi.fn(async (p: Page) => new Blob([`thumb:${p.id}`]));
    const ctx = await context(server, { makeThumbnail });

    const report = await runSync(ctx);
    expect(report.issues).toEqual([expect.objectContaining({ stage: 'download', id: 'p1' })]);
    const page = await db.pages.get('p1');
    expect(page).toMatchObject({ documentId: 'd1', ocrText: 'Hello', ocrStatus: 'done' });
    expect(page!.processedBlob).toBeUndefined();
    expect(page!.originalBlob).toBeUndefined();
    expect((await getFileRef('page', 'p1'))!.downloaded).toBe(false);
    expect(makeThumbnail).not.toHaveBeenCalled();
    expect(await readOutbox()).toEqual([]);

    server.objects.set(path, stored);
    clock += 10_000;
    await runSync(ctx);
    const after = await db.pages.get('p1');
    expect(await text(after!.processedBlob!)).toBe('remote-pixels');
    expect(after!.processedBlob!.type).toBe('image/png');
    expect((await getFileRef('page', 'p1'))!.downloaded).toBe(true);
    expect(makeThumbnail).toHaveBeenCalledTimes(1);
    expect(await text((await db.documents.get('d1'))!.thumbnailBlob!)).toBe('thumb:p1');
    // Writing the image didn't queue anything, and re-pushing would not re-upload
    expect(await readOutbox()).toEqual([]);
  });

  it('creates a pulled signature only once its image has arrived', async () => {
    const server = new FakeSupabase(USER_A);
    const path = await server.remoteFile(vault.key, 'sig-file', img('png', 'image/png'));
    await server.remoteRecord(vault.key, {
      kind: 'signature',
      id: 's1',
      updatedAt: Date.now(),
      value: { width: 10, height: 5, createdAt: new Date(), file: { id: 'sig-file', type: 'image/png' } },
      files: [path],
    });
    await runSync(await context(server));
    const sig = await db.signatures.get('s1');
    expect(sig).toMatchObject({ width: 10, height: 5 });
    expect(await text(sig!.blob)).toBe('png');
  });
});

describe('pull', () => {
  async function seedRemoteDocument(server: FakeSupabase, at = Date.now()) {
    const now = new Date(at);
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'f1', updatedAt: at, value: { name: 'Home', createdAt: now } });
    await server.remoteRecord(vault.key, {
      kind: 'document',
      id: 'd1',
      updatedAt: at,
      value: { name: 'Lease', folderId: 'f1', tags: ['home'], createdAt: now, updatedAt: now },
    });
    for (const [id, n] of [
      ['p1', 1],
      ['p2', 2],
    ] as const) {
      await server.remoteRecord(vault.key, {
        kind: 'page',
        id,
        updatedAt: at,
        value: { documentId: 'd1', pageNumber: n, filter: 'bw', createdAt: now, ocrText: `Text ${id}` },
      });
    }
  }

  it('applies remote changes without queueing them', async () => {
    const server = new FakeSupabase(USER_A);
    const at = Date.now() - 1000;
    await seedRemoteDocument(server, at);
    const report = await runSync(await context(server));

    expect(report.applied).toBe(4);
    expect(await db.folders.get('f1')).toMatchObject({ name: 'Home' });
    expect(await db.documents.get('d1')).toMatchObject({
      name: 'Lease',
      folderId: 'f1',
      tags: ['home'],
      pageCount: 2,
      searchText: 'text p1\ntext p2',
    });
    const p1 = await db.pages.get('p1');
    expect(p1!.updatedAt.getTime()).toBe(at);
    expect(p1!.filter).toBe('bw');
    expect(await readOutbox()).toEqual([]);
  });

  it('keeps a pending local edit that is newer than the remote row', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Doc', img('x'));
    const ctx = await context(server);
    await runSync(ctx);

    // Another device renames it; then we rename it later, but our push is held back
    const local = (await db.documents.get(docId))!;
    await server.remoteRecord(vault.key, {
      kind: 'document',
      id: docId,
      updatedAt: server.get('document', docId)!.updatedAt + 1,
      value: { name: 'Their name', createdAt: local.createdAt, updatedAt: local.updatedAt },
    });
    await new Promise((r) => setTimeout(r, 5));
    await renameDocument(docId, 'My newer name');
    ctx.retry.failed(`push:document:${docId}`, clock);

    const report = await runSync(ctx);
    expect(report.skipped).toBe(1);
    expect((await db.documents.get(docId))!.name).toBe('My newer name');

    clock += 10_000;
    await runSync(ctx);
    expect((await decrypted(server, 'document', docId)).name).toBe('My newer name');
  });

  it('cascades a document tombstone to its pages', async () => {
    const server = new FakeSupabase(USER_A);
    const docId = await createDocument('Doc', img('x'));
    await addPageToDocument(docId, img('y'));
    const pageIds = (await db.pages.where('documentId').equals(docId).primaryKeys()) as string[];
    await runSync(await context(server));
    await runSync(await context(server)); // first sync done; the next is a normal one

    await server.remoteRecord(vault.key, { kind: 'document', id: docId, updatedAt: Date.now() + 1000, deleted: true });
    await runSync(await context(server));

    expect(await db.documents.get(docId)).toBeUndefined();
    expect(await db.pages.bulkGet(pageIds)).toEqual([undefined, undefined]);
    expect(await getFileRef('page', pageIds[0])).toBeUndefined();
    expect(await readOutbox()).toEqual([]);
  });

  it('removes a page on its tombstone and renumbers the rest', async () => {
    const server = new FakeSupabase(USER_A);
    await seedRemoteDocument(server);
    await runSync(await context(server));
    await server.remoteRecord(vault.key, { kind: 'page', id: 'p1', updatedAt: Date.now() + 1000, deleted: true });
    await runSync(await context(server));
    expect(await db.pages.get('p1')).toBeUndefined();
    expect((await db.pages.get('p2'))!.pageNumber).toBe(1);
    expect(await db.documents.get('d1')).toMatchObject({ pageCount: 1, searchText: 'text p2' });
    expect(await readOutbox()).toEqual([]);
  });

  it('renumbers duplicate page numbers by (pageNumber, id) locally', async () => {
    const server = new FakeSupabase(USER_A);
    await seedRemoteDocument(server);
    await runSync(await context(server));
    // Another device added a page as number 2 at the same time as p2
    const now = new Date();
    await server.remoteRecord(vault.key, {
      kind: 'page',
      id: 'p0',
      updatedAt: Date.now() + 1000,
      value: { documentId: 'd1', pageNumber: 2, filter: 'original', createdAt: now, ocrText: 'Text p0' },
    });
    await runSync(await context(server));
    const pages = await db.pages.where('documentId').equals('d1').sortBy('pageNumber');
    expect(pages.map((p) => [p.id, p.pageNumber])).toEqual([
      ['p1', 1],
      ['p0', 2],
      ['p2', 3],
    ]);
    expect(await db.documents.get('d1')).toMatchObject({ pageCount: 3, searchText: 'text p1\ntext p0\ntext p2' });
    expect(await readOutbox()).toEqual([]);
  });

  it('skips rows that fail to decrypt and keeps going', async () => {
    const server = new FakeSupabase(USER_A);
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'ok', updatedAt: Date.now(), value: { name: 'OK', createdAt: new Date() } });
    server.write({
      kind: 'folder',
      id: 'bad',
      updatedAt: Date.now(),
      deviceId: 'other-device',
      deleted: false,
      keyVersion: 1,
      payload: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]),
      files: [],
    });
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'ok2', updatedAt: Date.now(), value: { name: 'OK2', createdAt: new Date() } });

    const report = await runSync(await context(server));
    expect(report.issues).toEqual([expect.objectContaining({ stage: 'pull', id: 'bad' })]);
    expect(await db.folders.get('ok')).toBeDefined();
    expect(await db.folders.get('ok2')).toBeDefined();
    expect(await db.folders.get('bad')).toBeUndefined();
    expect(await getCursor(USER_A)).toBe(server.seq);
  });

  it('saves the cursor per user after every batch and resumes from it', async () => {
    const server = new FakeSupabase(USER_A);
    for (let i = 0; i < 501; i++) {
      await server.remoteRecord(vault.key, { kind: 'folder', id: `f${i}`, updatedAt: Date.now(), value: { name: `F${i}`, createdAt: new Date() } });
    }
    server.failPullAfter = 500; // the second page fails like a dropped connection
    await expect(runSync(await context(server))).rejects.toMatchObject({ network: true });
    expect(await getCursor(USER_A)).toBe(500);
    expect(await db.folders.count()).toBe(500);

    server.failPullAfter = undefined;
    server.log = [];
    await runSync(await context(server));
    // Resumes after the saved cursor (the only pull from 0 is the merge's key check)
    expect(server.log).toContain('pull:500');
    expect(server.log.filter((l) => l === 'pull:0')).toHaveLength(1);
    expect(await db.folders.count()).toBe(501);
    expect((await db.syncMeta.get(cursorKey(USER_A)))!.value).toBe(501);
  });
});

describe('account switch', () => {
  it('treats a different account as a first sync: re-uploads everything, merges, deletes nothing', async () => {
    const serverA = new FakeSupabase(USER_A);
    const docId = await createDocument('Mine', img('pixels'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    await runSync(await context(serverA));

    // A local delete made before switching must not reach the new account
    const other = await createDocument('Deleted later', img('z'));
    await runSync(await context(serverA));
    // (The first run pushed after an empty pull; this one pulled the echo of that push)
    expect(await getCursor(USER_A)).toBeGreaterThan(0);
    await deleteDocument(other);

    const serverB = new FakeSupabase(USER_B);
    // Account B already has its own document, and a tombstone for ours
    const now = new Date();
    await serverB.remoteRecord(vault.key, { kind: 'document', id: 'b-doc', updatedAt: Date.now(), value: { name: 'B doc', createdAt: now, updatedAt: now } });
    await serverB.remoteRecord(vault.key, { kind: 'document', id: docId, updatedAt: Date.now() + 60_000, deleted: true });

    // Nothing moves until the user agrees to upload A's documents to B
    const paused = await runSync(await context(serverB));
    expect(paused.accountSwitch).toMatchObject({ previousUserId: USER_A, documents: 1, removed: false });
    expect(serverB.log).toEqual([]);
    await chooseUploadToAccount(USER_B);

    const report = await runSync(await context(serverB));
    expect(report.merged).toBe(true);
    // Everything local went up to B, files under B's folder
    const payload = await decrypted<{ file: { id: string } }>(serverB, 'page', page.id);
    expect(serverB.objects.has(`${USER_B}/${payload.file.id}`)).toBe(true);
    expect(serverB.get('document', other)).toBeUndefined();
    // Nothing deleted locally; B's document arrived
    expect(await db.documents.get(docId)).toBeDefined();
    expect(await db.documents.get('b-doc')).toMatchObject({ name: 'B doc' });
    // The cursor of A is gone; B's is set
    expect(await db.syncMeta.get(cursorKey(USER_A))).toBeUndefined();
    expect(await getCursor(USER_B)).toBeGreaterThan(0);

    // The tombstone lost: the next run brings the document back on B
    clock += 1000;
    const second = await runSync(await context(serverB));
    expect(second.merged).toBe(false);
    expect(serverB.get('document', docId)!.deleted).toBe(false);
    expect(await readOutbox()).toEqual([]);
  });

  it('refuses to merge when the vault key cannot read the account', async () => {
    const server = new FakeSupabase(USER_A);
    const otherKey = await generateVaultKey();
    await server.remoteRecord(otherKey, { kind: 'folder', id: 'f', updatedAt: Date.now(), value: { name: 'X', createdAt: new Date() } });
    await createDocument('Doc', img('x'));
    await expect(runSync(await context(server))).rejects.toBeInstanceOf(SyncError);
    expect(server.log).not.toContain('rpc:upsert_records');
    expect(server.objects.size).toBe(0);
  });
});

describe('withSyncLock', () => {
  it('uses Web Locks when available', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    expect(await withSyncLock(async () => 42, { request: request as <T>(n: string, cb: () => Promise<T>) => Promise<T> })).toBe(42);
    expect(request).toHaveBeenCalledWith(SYNC_LOCK_NAME, expect.any(Function));
  });

  it('falls back to serializing runs in the tab without Web Locks', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withSyncLock(async () => {
      order.push('a:start');
      await new Promise<void>((r) => (release = r));
      order.push('a:end');
    }, null);
    const second = withSyncLock(async () => {
      order.push('b');
    }, null);
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(['a:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['a:start', 'a:end', 'b']);
  });

  it('keeps going after a failed run', async () => {
    await expect(withSyncLock(async () => Promise.reject(new Error('boom')), null)).rejects.toThrow('boom');
    expect(await withSyncLock(async () => 'ok', null)).toBe('ok');
  });
});
