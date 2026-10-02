import Dexie, { type EntityTable } from 'dexie';
import type { ScannedDocument, Page, Signature } from '@/types';

export interface SettingRow {
  key: string;
  value: unknown;
}

const db = new Dexie('QuickScanDB') as Dexie & {
  documents: EntityTable<ScannedDocument, 'id'>;
  pages: EntityTable<Page, 'id'>;
  settings: EntityTable<SettingRow, 'key'>;
  signatures: EntityTable<Signature, 'id'>;
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

db.version(3).stores({
  signatures: 'id, createdAt',
});

export { db };
