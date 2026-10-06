import Dexie, { type EntityTable, type Table } from 'dexie';
import type { ScannedDocument, Page, Signature, Folder } from '@/types';
import { LEGACY_LLM_KEYS, migrateLegacyLlmSettings } from './llm-settings-migration';
import { SYNCED_SETTING_KEYS, syncTrackingMiddleware, type OutboxEntry } from './sync-tracking';
import { trackDatabase } from './db-status';
import type { StoredImage } from './images';
import { prepareImages } from './image-migration';

export interface SettingRow {
  key: string;
  value: unknown;
}

const db = new Dexie('QuickScanDB') as Dexie & {
  documents: EntityTable<ScannedDocument, 'id'>;
  pages: EntityTable<Page, 'id'>;
  settings: EntityTable<SettingRow, 'key'>;
  signatures: EntityTable<Signature, 'id'>;
  folders: EntityTable<Folder, 'id'>;
  outbox: Table<OutboxEntry, [OutboxEntry['kind'], string]>;
  syncMeta: EntityTable<SettingRow, 'key'>;
  images: EntityTable<StoredImage, 'id'>;
};

// Records local changes of synced tables in the outbox (see sync-tracking.ts)
db.use(syncTrackingMiddleware);

// Blocked upgrades, newer versions in other tabs and open errors become a status the UI
// shows (db-status.ts, <DatabaseGate/>) instead of an endless "Loading..."
trackDatabase(db);

db.version(1).stores({
  documents: 'id, name, createdAt, updatedAt',
  pages: 'id, documentId, [documentId+pageNumber]',
});

db.version(2)
  .stores({
    documents: 'id, name, createdAt, updatedAt',
    pages: 'id, documentId, [documentId+pageNumber], ocrStatus',
    settings: 'key',
  })
  .upgrade((tx) =>
    tx
      .table('pages')
      .toCollection()
      .modify((page: Page) => {
        page.ocrStatus = 'pending';
      })
  );

db.version(3).stores({
  signatures: 'id, createdAt',
});

db.version(4).stores({});

// Older custom endpoint settings (a single OpenAI-compatible endpoint, then a list of
// named endpoints) become the single custom endpoint
db.version(5).upgrade(async (tx) => {
  const settings = tx.table<SettingRow, string>('settings');
  const rows = await settings.toArray();
  const updates = migrateLegacyLlmSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  if (!updates) return;
  await settings.bulkPut(Object.entries(updates).map(([key, value]) => ({ key, value })));
  await settings.bulkDelete(LEGACY_LLM_KEYS);
});

// Folders & tags. Both fields are optional on documents, so existing documents need no
// rewrite: no folderId means unfiled, no tags means untagged.
db.version(6).stores({
  documents: 'id, name, createdAt, updatedAt, folderId, *tags',
  folders: 'id, name, createdAt, updatedAt',
});

// Cloud sync groundwork: pages get updatedAt; the outbox holds one pending change (or
// tombstone) per synced record; syncMeta holds device-local sync state such as the device id.
// Everything that exists already is queued once, so the outbox always lists every local
// record the server may not have.
db.version(7)
  .stores({
    outbox: '[kind+id], updatedAt',
    syncMeta: 'key',
  })
  .upgrade(async (tx) => {
    const docUpdated = new Map<string, Date>();
    const entries: OutboxEntry[] = [];
    const queue = (kind: OutboxEntry['kind'], id: string, at: Date | undefined, fileChanged = false) =>
      entries.push({ kind, id, op: 'upsert', updatedAt: at?.getTime() ?? Date.now(), fileChanged, rev: 1 });

    await tx.table<ScannedDocument, string>('documents').each((doc) => {
      docUpdated.set(doc.id, doc.updatedAt);
      queue('document', doc.id, doc.updatedAt);
    });
    const now = new Date();
    await tx
      .table<Page, string>('pages')
      .toCollection()
      .modify((page: Page & { processedBlob?: Blob }) => {
        page.updatedAt ??= docUpdated.get(page.documentId) ?? page.createdAt ?? now;
        queue('page', page.id, page.updatedAt, page.processedBlob != null);
      });
    await tx.table<Folder, string>('folders').each((f) => queue('folder', f.id, f.updatedAt));
    await tx.table<Signature, string>('signatures').each((s) => queue('signature', s.id, s.createdAt, true));
    const settings = await tx.table<SettingRow, string>('settings').bulkGet([...SYNCED_SETTING_KEYS]);
    for (const row of settings) if (row) queue('settings', row.key, now);

    await tx.table('outbox').bulkPut(entries);
  });

// Images get a table of their own, whose rows are never rewritten (lib/images.ts, #89). The
// Blobs already stored on pages and documents move over when the database opens, not here:
// see image-migration.ts. The id fields are indexed to find whether anything still uses an
// image (deleteImagesIfUnused).
db.version(8).stores({
  documents: 'id, name, createdAt, updatedAt, folderId, *tags, thumbnailId',
  pages: 'id, documentId, [documentId+pageNumber], ocrStatus, processedImageId, originalImageId',
  images: 'id',
});

// Sticky: runs on every open, before any other query goes through
db.on('ready', (vipDb) => prepareImages(vipDb), true);

export { db };
