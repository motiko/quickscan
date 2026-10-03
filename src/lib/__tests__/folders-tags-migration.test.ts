import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';

describe('folders & tags schema upgrade (v6)', () => {
  it('keeps existing documents valid: unfiled and untagged', async () => {
    // A database as it was at schema version 5
    const legacy = new Dexie('QuickScanDB');
    legacy.version(5).stores({
      documents: 'id, name, createdAt, updatedAt',
      pages: 'id, documentId, [documentId+pageNumber], ocrStatus',
      settings: 'key',
      signatures: 'id, createdAt',
    });
    const created = new Date('2026-01-01T00:00:00Z');
    await legacy.table('documents').bulkPut([
      { id: 'a', name: 'Invoice', createdAt: created, updatedAt: created, pageCount: 1 },
      { id: 'b', name: 'Receipt', createdAt: created, updatedAt: created, pageCount: 2 },
    ]);
    await legacy
      .table('pages')
      .put({ id: 'p1', documentId: 'a', pageNumber: 1, filter: 'original', createdAt: created });
    legacy.close();

    const { db } = await import('@/lib/db');
    await db.open();
    expect(db.verno).toBeGreaterThanOrEqual(6);

    const docs = await db.documents.orderBy('id').toArray();
    expect(docs.map((d) => d.name)).toEqual(['Invoice', 'Receipt']);
    for (const doc of docs) {
      expect(doc.folderId).toBeUndefined();
      expect(doc.tags).toBeUndefined();
      // Untouched by the upgrade
      expect(doc.updatedAt).toEqual(created);
    }
    expect(await db.pages.count()).toBe(1);
    expect(await db.folders.count()).toBe(0);

    // The new indexes work on upgraded data
    expect(await db.documents.where('folderId').equals('x').count()).toBe(0);
    await db.documents.update('a', { tags: ['tax'] });
    expect((await db.documents.where('tags').equals('tax').toArray()).map((d) => d.id)).toEqual(['a']);

    const { filterDocuments } = await import('@/lib/document-filter');
    const all = await db.documents.toArray();
    expect(filterDocuments(all, { folder: { kind: 'unfiled' }, tags: [], query: '' }, new Set())).toHaveLength(2);
  });
});
