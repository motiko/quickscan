import Dexie, { type EntityTable } from 'dexie';
import type { ScannedDocument, Page, Signature } from '@/types';
import { LEGACY_LLM_KEYS, migrateLegacyLlmSettings } from './llm-settings-migration';

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

// The single OpenAI-compatible endpoint became one of several providers
db.version(4).upgrade(async (tx) => {
  const settings = tx.table<SettingRow, string>('settings');
  const rows = await settings.toArray();
  const updates = migrateLegacyLlmSettings(Object.fromEntries(rows.map((r) => [r.key, r.value])));
  if (!updates) return;
  await settings.bulkPut(Object.entries(updates).map(([key, value]) => ({ key, value })));
  await settings.bulkDelete(LEGACY_LLM_KEYS);
});

export { db };
