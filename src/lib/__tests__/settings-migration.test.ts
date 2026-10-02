import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import Dexie from 'dexie';

describe('settings schema upgrade', () => {
  it('moves the legacy OpenAI-compatible endpoint into the custom endpoint', async () => {
    // A database as it was at schema version 3
    const legacy = new Dexie('QuickScanDB');
    legacy.version(3).stores({
      documents: 'id, name, createdAt, updatedAt',
      pages: 'id, documentId, [documentId+pageNumber], ocrStatus',
      settings: 'key',
      signatures: 'id, createdAt',
    });
    await legacy.table('settings').bulkPut([
      { key: 'llmEnabled', value: true },
      { key: 'llmBaseUrl', value: 'http://localhost:11434/v1' },
      { key: 'llmApiKey', value: '' },
      { key: 'llmModel', value: 'gemma4:31b' },
    ]);
    legacy.close();

    const { getSettings } = await import('@/lib/settings');
    const settings = await getSettings();

    expect(settings.llmEnabled).toBe(true);
    expect(settings.llmProvider).toBe('custom');
    expect(settings.llmCustomEndpoint).toEqual({
      schema: 'chat-completions',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'gemma4:31b',
    });
    expect(settings).not.toHaveProperty('llmBaseUrl');
  });
});
