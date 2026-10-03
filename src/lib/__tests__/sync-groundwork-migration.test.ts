import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';

describe('sync groundwork schema upgrade (v7)', () => {
  it('backfills page updatedAt and queues every existing record once', async () => {
    // A database as it was at schema version 6
    const legacy = new Dexie('QuickScanDB');
    legacy.version(6).stores({
      documents: 'id, name, createdAt, updatedAt, folderId, *tags',
      pages: 'id, documentId, [documentId+pageNumber], ocrStatus',
      settings: 'key',
      signatures: 'id, createdAt',
      folders: 'id, name, createdAt, updatedAt',
    });
    const created = new Date('2026-01-01T00:00:00Z');
    const edited = new Date('2026-02-01T00:00:00Z');
    await legacy.table('documents').put({ id: 'd1', name: 'Invoice', createdAt: created, updatedAt: edited, pageCount: 2 });
    await legacy.table('pages').bulkPut([
      { id: 'p1', documentId: 'd1', pageNumber: 1, filter: 'original', createdAt: created, processedBlob: new Blob(['x']) },
      { id: 'p2', documentId: 'd1', pageNumber: 2, filter: 'original', createdAt: created },
      // Orphan page: falls back to its own createdAt
      { id: 'p3', documentId: 'gone', pageNumber: 1, filter: 'original', createdAt: created },
    ]);
    await legacy.table('folders').put({ id: 'f1', name: 'Tax', createdAt: created, updatedAt: created });
    await legacy.table('signatures').put({ id: 's1', blob: new Blob(['png']), width: 1, height: 1, createdAt: created });
    await legacy.table('settings').bulkPut([
      { key: 'ocrLanguages', value: ['eng', 'deu'] },
      { key: 'openaiApiKey', value: 'sk-secret' },
    ]);
    legacy.close();

    const { db } = await import('@/lib/db');
    await db.open();
    expect(db.verno).toBe(7);

    const pages = await db.pages.orderBy('id').toArray();
    expect(pages.map((p) => p.updatedAt)).toEqual([edited, edited, created]);

    const outbox = await db.outbox.toArray();
    const summary = outbox.map((e) => `${e.kind}:${e.id}:${e.op}:${e.fileChanged}`).sort();
    expect(summary).toEqual([
      'document:d1:upsert:false',
      'folder:f1:upsert:false',
      'page:p1:upsert:true',
      'page:p2:upsert:false',
      'page:p3:upsert:false',
      'settings:ocrLanguages:upsert:false',
      'signature:s1:upsert:true',
    ]);
    expect(outbox.find((e) => e.id === 'd1')?.updatedAt).toBe(edited.getTime());

    // Untouched by the upgrade
    const doc = await db.documents.get('d1');
    expect(doc?.updatedAt).toEqual(edited);
  });
});
