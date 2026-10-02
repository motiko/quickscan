import Dexie, { type EntityTable } from 'dexie';
import type { ScannedDocument, Page } from '@/types';

export interface SettingRow {
  key: string;
  value: unknown;
}

const db = new Dexie('QuickScanDB') as Dexie & {
  documents: EntityTable<ScannedDocument, 'id'>;
  pages: EntityTable<Page, 'id'>;
  settings: EntityTable<SettingRow, 'key'>;
};

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

export { db };
