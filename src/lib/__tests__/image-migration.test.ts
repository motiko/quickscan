import 'fake-indexeddb/auto';
import { describe, it, expect, vi } from 'vitest';
import Dexie, { type DBCore, type Middleware } from 'dexie';
import { migrateLegacyImages, pruneOrphanImages } from '@/lib/image-migration';

/*
 * v8 moved images off pages and documents into `images` (lib/images.ts, #89). The Blobs already
 * stored move when the database opens, one record at a time, untracked; one that can't be
 * moved stays where it is and doesn't stop the rest.
 */

const created = new Date('2026-01-01T00:00:00Z');

async function legacyDatabase(): Promise<void> {
  // A database as it was at schema version 7
  const legacy = new Dexie('QuickScanDB');
  legacy.version(7).stores({
    documents: 'id, name, createdAt, updatedAt, folderId, *tags',
    pages: 'id, documentId, [documentId+pageNumber], ocrStatus',
    settings: 'key',
    signatures: 'id, createdAt',
    folders: 'id, name, createdAt, updatedAt',
    outbox: '[kind+id], updatedAt',
    syncMeta: 'key',
  });
  await legacy.table('documents').put({
    id: 'd1', name: 'Invoice', createdAt: created, updatedAt: created, pageCount: 3, thumbnailBlob: new Blob(['thumb']),
  });
  const page = { documentId: 'd1', filter: 'original', createdAt: created, updatedAt: created, ocrStatus: 'done' };
  await legacy.table('pages').bulkPut([
    // A capture: original and processed image start as the same bytes
    { ...page, id: 'p1', pageNumber: 1, originalBlob: new Blob(['scan']), processedBlob: new Blob(['scan']) },
    // Edited (turned) since
    { ...page, id: 'p2', pageNumber: 2, originalBlob: new Blob(['raw']), processedBlob: new Blob(['raw@90']) },
    // Pulled from another device, image not downloaded yet
    { ...page, id: 'p3', pageNumber: 3 },
  ]);
  await legacy.table('outbox').put({ kind: 'page', id: 'p2', op: 'upsert', updatedAt: 1, fileChanged: true, rev: 4 });
  legacy.close();
}

const text = async (db: Dexie, id: string | undefined) =>
  id ? (await db.table('images').get(id))?.blob.text() : undefined;

describe('image store migration (v8)', () => {
  it('moves page images and thumbnails into images when the database opens, without queueing a sync', async () => {
    await legacyDatabase();
    const { db } = await import('@/lib/db');
    await db.open();
    expect(db.verno).toBe(8);

    const [p1, p2, p3] = (await db.pages.orderBy('id').toArray()) as unknown as (Record<string, unknown> & { id: string })[];
    expect('originalBlob' in p1 || 'processedBlob' in p1 || 'originalBlob' in p2 || 'processedBlob' in p2).toBe(false);
    // One stored image for identical bytes
    expect(p1.processedImageId).toBeDefined();
    expect(p1.originalImageId).toBe(p1.processedImageId);
    expect(await text(db, p1.processedImageId as string)).toBe('scan');
    expect(await text(db, p2.originalImageId as string)).toBe('raw');
    expect(await text(db, p2.processedImageId as string)).toBe('raw@90');
    expect(p3.processedImageId).toBeUndefined();
    // Everything else as it was
    expect(p1).toMatchObject({ documentId: 'd1', pageNumber: 1, ocrStatus: 'done', updatedAt: created });

    const doc = (await db.documents.get('d1')) as unknown as Record<string, unknown>;
    expect('thumbnailBlob' in doc).toBe(false);
    expect(await text(db, doc.thumbnailId as string)).toBe('thumb');
    expect(doc.updatedAt).toEqual(created);
    expect(await db.images.count()).toBe(4);

    // Moving isn't an edit: the outbox is as it was
    expect(await db.outbox.toArray()).toEqual([
      { kind: 'page', id: 'p2', op: 'upsert', updatedAt: 1, fileChanged: true, rev: 4 },
    ]);

    // Running again changes nothing
    await migrateLegacyImages(db);
    expect(await db.images.count()).toBe(4);
    db.close();
  });

  it('leaves a record whose image cannot be stored as it is, and moves the others', async () => {
    const failing: Middleware<DBCore> = {
      stack: 'dbcore',
      name: 'FailOneImage',
      create: (down) => ({
        ...down,
        table: (name) => {
          const table = down.table(name);
          if (name !== 'images') return table;
          return {
            ...table,
            mutate: (req) =>
              'values' in req && req.values.some((v) => (v as { blob: Blob }).blob.size === 'lost'.length)
                ? Promise.reject(new DOMException('The blob is gone', 'NotFoundError'))
                : table.mutate(req),
          };
        },
      }),
    };
    const db = new Dexie('MigrationFailure');
    db.use(failing);
    db.version(1).stores({ pages: 'id', documents: 'id', images: 'id' });
    await db.table('pages').bulkPut([
      { id: 'a', originalBlob: new Blob(['lost']) },
      { id: 'b', originalBlob: new Blob(['still here']) },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await migrateLegacyImages(db);

    const a = await db.table('pages').get('a');
    expect(await a.originalBlob.text()).toBe('lost');
    expect(a.originalImageId).toBeUndefined();
    const b = await db.table('pages').get('b');
    expect(b.originalBlob).toBeUndefined();
    expect(await text(db, b.originalImageId)).toBe('still here');
    expect(warn).toHaveBeenCalledWith('Could not move the images of pages a', expect.anything());
    warn.mockRestore();
    db.close();
  });

  it('prunes images nothing points to, once they were already unused at the previous start', async () => {
    const db = new Dexie('Prune');
    db.version(1).stores({ pages: 'id', documents: 'id', images: 'id', syncMeta: 'key' });
    const image = (id: string) => ({ id, blob: new Blob([id]), createdAt: created });
    await db.table('images').bulkPut(['orig', 'shown', 'thumb', 'replaced', 'deleted-page'].map(image));
    await db.table('pages').put({ id: 'p', originalImageId: 'orig', processedImageId: 'shown' });
    await db.table('documents').put({ id: 'd', thumbnailId: 'thumb' });

    // First start: only noted (another tab may still show a replaced image)
    expect(await pruneOrphanImages(db)).toBe(0);
    expect(await db.table('images').count()).toBe(5);
    // Meanwhile one is used again (a conflicted copy keeps it) and another is replaced
    await db.table('pages').put({ id: 'copy', processedImageId: 'replaced' });
    await db.table('documents').put({ id: 'd', thumbnailId: 'thumb2' });
    await db.table('images').put(image('thumb2'));

    expect(await pruneOrphanImages(db)).toBe(1);
    expect((await db.table('images').toCollection().primaryKeys()).sort()).toEqual(['orig', 'replaced', 'shown', 'thumb', 'thumb2']);
    expect(await pruneOrphanImages(db)).toBe(1);
    expect((await db.table('images').toCollection().primaryKeys()).sort()).toEqual(['orig', 'replaced', 'shown', 'thumb2']);
    expect(await pruneOrphanImages(db)).toBe(0);
    expect(await db.table('syncMeta').count()).toBe(0);
    db.close();
  });
});
