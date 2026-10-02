import Dexie, { type EntityTable } from 'dexie';
import type { ScannedDocument, Page } from '@/types';

const db = new Dexie('QuickScanDB') as Dexie & {
  documents: EntityTable<ScannedDocument, 'id'>;
  pages: EntityTable<Page, 'id'>;
};

db.version(1).stores({
  documents: 'id, name, createdAt, updatedAt',
  pages: 'id, documentId, [documentId+pageNumber]',
});

export { db };
