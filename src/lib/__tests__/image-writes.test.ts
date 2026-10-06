import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DBCore, DBCoreMutateRequest, Middleware } from 'dexie';

/*
 * #89: in WebKit, rewriting a record that holds a Blob, while the old Blob is still being read
 * or shown, loses Blobs for good. So no write to `pages` or `documents` may carry a Blob, and
 * `images` rows are only ever added, never written over. A spy under every other middleware
 * sees each write exactly as it reaches IndexedDB.
 */

vi.mock('@/lib/ocr', () => ({ recognize: vi.fn() }));
vi.mock('@/lib/native-passkey', () => ({ isNativeApp: vi.fn(() => true) }));
vi.mock('@/lib/platform/native/ocr', () => ({
  canRecognize: vi.fn(async () => true),
  nativeOcr: { engine: 'vision', recognize: vi.fn() },
}));
vi.mock('@/lib/image-processing', () => ({
  fitImage: vi.fn(async (blob: Blob) => ({ blob, scale: 1 })),
  rotateImage: vi.fn(async (blob: Blob, degrees: number) => new Blob([`${await blob.text()}@${degrees}`])),
  createThumbnail: vi.fn(async (blob: Blob) => new Blob([`thumb:${await blob.text()}`])),
}));
vi.mock('@/lib/annotations/flatten', () => ({
  getImageSize: vi.fn(async () => ({ width: 100, height: 200 })),
  getRenderedBlob: vi.fn(async (page: { processedImageId?: string; originalImageId?: string }) => {
    const { requirePageImage } = await import('@/lib/page-image');
    return requirePageImage(page);
  }),
}));

import { db } from '@/lib/db';
import { nativeOcr } from '@/lib/platform/native/ocr';
import { processPendingOcr } from '@/lib/ocr-queue';
import { getImage } from '@/lib/images';
import { pageImageId } from '@/lib/page-image';
import {
  createDocumentWithPages,
  addPagesToDocument,
  updatePage,
  savePageAnnotations,
  deletePage,
  renameDocument,
  deleteDocument,
} from '@/hooks/useDocuments';

const writes: { table: string; type: DBCoreMutateRequest['type']; values: unknown[] }[] = [];
const spy: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'ImageWriteSpy',
  level: -100, // below the sync-tracking middleware: sees what IndexedDB gets
  create: (down) => ({
    ...down,
    table: (name) => {
      const table = down.table(name);
      return {
        ...table,
        mutate: (req) => {
          writes.push({ table: name, type: req.type, values: 'values' in req ? [...req.values] : [] });
          return table.mutate(req);
        },
      };
    },
  }),
};
db.use(spy);

const holdsBlob = (value: unknown) =>
  typeof value === 'object' && value !== null && Object.values(value).some((v) => v instanceof Blob);

beforeEach(async () => {
  await db.delete();
  await db.open();
  writes.length = 0;
});

describe('image writes (#89)', () => {
  it('never writes a Blob onto a page or document, and never writes over an image', async () => {
    vi.mocked(nativeOcr.recognize).mockResolvedValue({
      text: 'Rechnung 2026-0042 Gesamtbetrag',
      words: [],
      confidence: 100,
      uprightRotation: 180,
      imageSize: { width: 100, height: 200 },
    });

    // Capture, OCR with an automatic turn (new page image and thumbnail), search text
    const docId = await createDocumentWithPages('Scan', [new Blob(['one']), new Blob(['two'])]);
    await processPendingOcr();
    await addPagesToDocument(docId, [new Blob(['three'])]);
    await processPendingOcr();

    // Edits by hand
    const [first, second] = await db.pages.where('documentId').equals(docId).sortBy('pageNumber');
    await updatePage(second.id, { processedImage: new Blob(['two, turned by hand']) });
    await savePageAnnotations(first.id, [
      { id: 'a1', type: 'rect', x: 0.1, y: 0.1, w: 0.5, h: 0.2, color: '#f00', width: 0.01 },
    ]);
    await renameDocument(docId, 'Invoice');
    await deletePage(first.id);
    await processPendingOcr();

    const pageOrDocWrites = writes.filter((w) => w.table === 'pages' || w.table === 'documents');
    expect(pageOrDocWrites.length).toBeGreaterThan(10);
    expect(pageOrDocWrites.filter((w) => w.values.some(holdsBlob))).toEqual([]);

    const imageWrites = writes.filter((w) => w.table === 'images');
    expect(imageWrites.length).toBeGreaterThan(0);
    expect(imageWrites.map((w) => w.type).filter((t) => t !== 'add' && t !== 'delete')).toEqual([]);
    const added = imageWrites.flatMap((w) => w.values.map((v) => (v as { id: string }).id));
    expect(new Set(added).size).toBe(added.length);

    // And the images are where the records say
    const pages = await db.pages.where('documentId').equals(docId).sortBy('pageNumber');
    expect(await Promise.all(pages.map(async (p) => (await getImage(pageImageId(p)))?.text()))).toEqual([
      'two, turned by hand',
      'three@180',
    ]);
    const doc = await db.documents.get(docId);
    expect(await (await getImage(doc?.thumbnailId))?.text()).toBe('thumb:two, turned by hand');
  });

  it('keeps one stored image for a capture whose original and processed image are the same', async () => {
    const docId = await createDocumentWithPages('Scan', [new Blob(['one'])]);
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    expect(page.originalImageId).toBeDefined();
    expect(page.processedImageId).toBe(page.originalImageId);
    // The page image and the thumbnail
    expect(await db.images.count()).toBe(2);
  });

  it('deletes the images of a deleted document, except one another page still uses', async () => {
    const keep = await createDocumentWithPages('Keep', [new Blob(['keep'])]);
    const gone = await createDocumentWithPages('Gone', [new Blob(['a']), new Blob(['b'])]);
    const [shared] = await db.pages.where('documentId').equals(gone).sortBy('pageNumber');
    // A conflicted copy in the kept document shares the first page's image
    const [kept] = await db.pages.where('documentId').equals(keep).toArray();
    await db.pages.put({ ...kept, id: 'copy', pageNumber: 2, processedImageId: shared.processedImageId, originalImageId: undefined });

    await deleteDocument(gone);

    const left = await db.images.toArray();
    expect((await Promise.all(left.map((i) => i.blob.text()))).sort()).toEqual(['a', 'keep', 'thumb:keep']);
  });
});
