import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db } from '@/lib/db';
import { updateSettings } from '@/lib/settings';
import { autoNameIfDefault, suggestDocumentName } from '@/lib/naming';
import type { Page, ScannedDocument } from '@/types';

const INVOICE_TEXT = 'ACME Widgets GmbH\nRechnung\nRechnungsdatum: 14.09.2026';

function page(id: string, pageNumber: number, overrides: Partial<Page> = {}): Page {
  return {
    id,
    documentId: 'doc1',
    pageNumber,
    originalBlob: new Blob([id]),
    filter: 'original',
    createdAt: new Date(),
    updatedAt: new Date(),
    ocrStatus: 'done',
    ocrText: '',
    ...overrides,
  };
}

async function addDoc(overrides: Partial<ScannedDocument> = {}) {
  await db.documents.add({
    id: 'doc1',
    name: 'Scan 2026-10-01 12:00',
    createdAt: new Date('2026-10-01T12:00:00Z'),
    updatedAt: new Date(),
    pageCount: 2,
    nameSource: 'default',
    ...overrides,
  });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('autoNameIfDefault', () => {
  it('renames a default-named document once all pages are recognized', async () => {
    await addDoc();
    await db.pages.bulkAdd([page('p1', 1, { ocrText: INVOICE_TEXT }), page('p2', 2, { ocrStatus: 'pending' })]);

    await autoNameIfDefault('doc1');
    expect((await db.documents.get('doc1'))?.nameSource).toBe('default');

    await db.pages.update('p2', { ocrStatus: 'done', ocrText: 'Seite 2' });
    await autoNameIfDefault('doc1');

    const doc = await db.documents.get('doc1');
    expect(doc?.name).toBe('Rechnung – ACME Widgets GmbH – 2026-09-14');
    expect(doc?.nameSource).toBe('auto');
  });

  it('never renames user-named or legacy documents', async () => {
    await addDoc({ nameSource: 'user', name: 'My taxes' });
    await db.pages.add(page('p1', 1, { ocrText: INVOICE_TEXT }));
    await autoNameIfDefault('doc1');
    expect((await db.documents.get('doc1'))?.name).toBe('My taxes');

    await db.documents.update('doc1', { nameSource: undefined });
    await autoNameIfDefault('doc1');
    expect((await db.documents.get('doc1'))?.name).toBe('My taxes');
  });
});

describe('suggestDocumentName', () => {
  it('uses the configured LLM', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: 'Rechnung ACME September' } }] }))
    );
    vi.stubGlobal('fetch', fetchMock);
    await updateSettings({
      llmEnabled: true,
      llmProvider: 'custom',
      llmCustomEndpoint: { schema: 'chat-completions', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.2' },
    });
    await addDoc();
    await db.pages.add(page('p1', 1, { ocrText: INVOICE_TEXT }));

    expect(await suggestDocumentName('doc1')).toEqual({ name: 'Rechnung ACME September', source: 'llm' });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('falls back to heuristics when the LLM fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await updateSettings({
      llmEnabled: true,
      llmProvider: 'custom',
      llmCustomEndpoint: { schema: 'chat-completions', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: 'llama3.2' },
    });
    await addDoc();
    await db.pages.add(page('p1', 1, { ocrText: INVOICE_TEXT }));

    expect(await suggestDocumentName('doc1')).toEqual({
      name: 'Rechnung – ACME Widgets GmbH – 2026-09-14',
      source: 'heuristic',
    });
  });

  it('returns null when there is no recognized text', async () => {
    await addDoc();
    await db.pages.add(page('p1', 1, { ocrStatus: 'pending' }));
    expect(await suggestDocumentName('doc1')).toBeNull();
  });
});
