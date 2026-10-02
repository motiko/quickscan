import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ocr', () => ({ recognize: vi.fn() }));
vi.mock('@/lib/llm/image', () => ({ prepareImageForLlm: vi.fn() }));
vi.mock('@/lib/llm/transcription', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/llm/transcription')>()),
  transcribeWithLlm: vi.fn(),
}));

import { db } from '@/lib/db';
import { recognize } from '@/lib/ocr';
import { prepareImageForLlm } from '@/lib/llm/image';
import { transcribeWithLlm } from '@/lib/llm/transcription';
import { cloudOcrPageUpdate, getCloudOcrStates, retryOcrWithLlm } from '@/lib/cloud-ocr';
import { onPageOcrDone, retryOcr } from '@/lib/ocr-queue';
import { updateSettings } from '@/lib/settings';
import type { OcrWord, Page } from '@/types';

const mockRecognize = vi.mocked(recognize);
const mockTranscribe = vi.mocked(transcribeWithLlm);

const words: OcrWord[] = [{ text: 'Invoce', bbox: { x0: 1, y0: 2, x1: 30, y1: 12 }, confidence: 60 }];

function makePage(overrides: Partial<Page> = {}): Page {
  return {
    id: 'p1',
    documentId: 'doc1',
    pageNumber: 1,
    originalBlob: new Blob(['p1']),
    filter: 'original',
    createdAt: new Date(),
    ocrStatus: 'done',
    ocrText: 'Invoce 42',
    ocrWords: words,
    ocrInfo: { engine: 'tesseract', languages: ['eng'], confidence: 60, recognizedAt: new Date(2026, 0, 1) },
    ...overrides,
  };
}

beforeEach(async () => {
  mockRecognize.mockReset();
  mockTranscribe.mockReset();
  vi.mocked(prepareImageForLlm).mockResolvedValue({ mediaType: 'image/jpeg', data: 'AAAA' });
  await db.delete();
  await db.open();
  await db.documents.add({ id: 'doc1', name: 'Scan', createdAt: new Date(), updatedAt: new Date(), pageCount: 1 });
  await updateSettings({
    llmEnabled: true,
    llmProvider: 'anthropic',
    anthropicApiKey: 'sk-ant',
    anthropicModel: 'claude-test',
  });
});

describe('cloudOcrPageUpdate', () => {
  it('records the model as the engine and leaves word boxes out of the update', () => {
    const at = new Date(2026, 9, 3);
    const update = cloudOcrPageUpdate('Invoice 42', { provider: 'openai', model: 'gpt-x' }, 'eng', at);
    expect(update).toEqual({
      ocrStatus: 'done',
      ocrText: 'Invoice 42',
      ocrInfo: { engine: 'llm', provider: 'openai', model: 'gpt-x', detectedLanguage: 'eng', recognizedAt: at },
    });
    expect(update).not.toHaveProperty('ocrWords');
  });
});

describe('retryOcrWithLlm', () => {
  it('replaces the text, keeps Tesseract word boxes, rebuilds search text and notifies listeners', async () => {
    mockTranscribe.mockResolvedValue('Invoice 42');
    await db.pages.add(makePage());
    const listener = vi.fn();
    const unsubscribe = onPageOcrDone(listener);

    await retryOcrWithLlm(['p1']);
    unsubscribe();

    const page = await db.pages.get('p1');
    expect(page?.ocrText).toBe('Invoice 42');
    expect(page?.ocrWords).toEqual(words);
    expect(page?.ocrInfo).toMatchObject({ engine: 'llm', provider: 'anthropic', model: 'claude-test' });
    expect((await db.documents.get('doc1'))?.searchText).toBe('invoice 42');
    expect(listener).toHaveBeenCalledWith('doc1', 1);
    expect(getCloudOcrStates().has('p1')).toBe(false);
  });

  it('keeps the existing text and records an error when the model fails', async () => {
    mockTranscribe.mockRejectedValue(new Error('The model declined to transcribe this page'));
    await db.pages.add(makePage());

    await retryOcrWithLlm(['p1']);

    const page = await db.pages.get('p1');
    expect(page?.ocrText).toBe('Invoce 42');
    expect(page?.ocrInfo?.engine).toBe('tesseract');
    expect(getCloudOcrStates().get('p1')).toEqual({
      status: 'error',
      message: 'The model declined to transcribe this page',
    });
  });

  it('fails without calling a model when none is configured', async () => {
    await updateSettings({ llmEnabled: false });
    await db.pages.add(makePage());

    await retryOcrWithLlm(['p1']);

    expect(mockTranscribe).not.toHaveBeenCalled();
    expect(getCloudOcrStates().get('p1')).toMatchObject({ status: 'error' });
  });

  it('discards the result when Tesseract recognized the page again meanwhile', async () => {
    await db.pages.add(makePage());
    mockTranscribe.mockImplementation(async () => {
      await db.pages.update('p1', {
        ocrText: 'Fresh',
        ocrInfo: { engine: 'tesseract', languages: ['eng'], recognizedAt: new Date(2026, 5, 1) },
      });
      return 'Stale';
    });

    await retryOcrWithLlm(['p1']);

    expect((await db.pages.get('p1'))?.ocrText).toBe('Fresh');
  });

  it('is overwritten by a later Tesseract retry', async () => {
    mockTranscribe.mockResolvedValue('Invoice 42');
    mockRecognize.mockResolvedValue({ text: 'Tesseract text', words, confidence: 80 });
    await db.pages.add(makePage());

    await retryOcrWithLlm(['p1']);
    await retryOcr('p1');

    const page = await db.pages.get('p1');
    expect(page?.ocrText).toBe('Tesseract text');
    expect(page?.ocrInfo).toMatchObject({ engine: 'tesseract', confidence: 80 });
  });
});
