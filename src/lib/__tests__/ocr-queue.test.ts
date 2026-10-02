import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ocr', () => ({
  recognize: vi.fn(),
}));

import { db } from '@/lib/db';
import { recognize } from '@/lib/ocr';
import { processPendingOcr, onPageOcrDone, resetStaleOcr } from '@/lib/ocr-queue';
import { updateSettings } from '@/lib/settings';
import type { Page } from '@/types';

const mockRecognize = vi.mocked(recognize);

function makePage(id: string, pageNumber: number, overrides: Partial<Page> = {}): Page {
  return {
    id,
    documentId: 'doc1',
    pageNumber,
    originalBlob: new Blob([id]),
    filter: 'original',
    createdAt: new Date(),
    ocrStatus: 'pending',
    ...overrides,
  };
}

beforeEach(async () => {
  mockRecognize.mockReset();
  await db.delete();
  await db.open();
  await db.documents.add({
    id: 'doc1',
    name: 'Scan',
    createdAt: new Date(),
    updatedAt: new Date(),
    pageCount: 2,
  });
});

describe('processPendingOcr', () => {
  it('recognizes pending pages and builds lower-cased search text in page order', async () => {
    mockRecognize.mockImplementation(async (blob: Blob) => {
      const id = await blob.text();
      return { text: `Text of ${id.toUpperCase()}`, words: [], confidence: 90 };
    });
    await db.pages.bulkAdd([makePage('p2', 2), makePage('p1', 1)]);

    await processPendingOcr();

    const pages = await db.pages.orderBy('id').toArray();
    expect(pages.map((p) => p.ocrStatus)).toEqual(['done', 'done']);
    expect(pages[0].ocrText).toBe('Text of P1');
    expect(pages[0].ocrLang).toBe('eng');
    const doc = await db.documents.get('doc1');
    expect(doc?.searchText).toBe('text of p1\ntext of p2');
  });

  it('passes the configured languages to the recognizer', async () => {
    mockRecognize.mockResolvedValue({ text: '', words: [], confidence: 0 });
    await updateSettings({ ocrLanguages: ['eng', 'deu'] });
    await db.pages.add(makePage('p1', 1));

    await processPendingOcr();

    expect(mockRecognize).toHaveBeenCalledWith(expect.any(Blob), ['eng', 'deu']);
    expect((await db.pages.get('p1'))?.ocrLang).toBe('eng+deu');
  });

  it('marks a page as error when recognition throws', async () => {
    mockRecognize.mockRejectedValue(new Error('offline'));
    await db.pages.add(makePage('p1', 1));

    await processPendingOcr();

    expect((await db.pages.get('p1'))?.ocrStatus).toBe('error');
  });

  it('does nothing when OCR is disabled', async () => {
    await updateSettings({ ocrEnabled: false });
    await db.pages.add(makePage('p1', 1));

    await processPendingOcr();

    expect(mockRecognize).not.toHaveBeenCalled();
    expect((await db.pages.get('p1'))?.ocrStatus).toBe('pending');
  });

  it('discards results if the image changed during recognition', async () => {
    mockRecognize.mockImplementation(async () => {
      // Simulate a rotate while OCR is running
      await db.pages.update('p1', { ocrStatus: 'pending' });
      mockRecognize.mockResolvedValue({ text: 'rotated', words: [], confidence: 90 });
      return { text: 'stale', words: [], confidence: 90 };
    });
    await db.pages.add(makePage('p1', 1));

    await processPendingOcr();
    await processPendingOcr();

    expect((await db.pages.get('p1'))?.ocrText).toBe('rotated');
  });

  it('notifies listeners with the document and page number', async () => {
    mockRecognize.mockResolvedValue({ text: 'x', words: [], confidence: 90 });
    const listener = vi.fn();
    const unsubscribe = onPageOcrDone(listener);
    await db.pages.add(makePage('p1', 1));

    await processPendingOcr();
    unsubscribe();

    expect(listener).toHaveBeenCalledWith('doc1', 1);
  });
});

describe('resetStaleOcr', () => {
  it('re-queues pages stuck in processing', async () => {
    await db.pages.add(makePage('p1', 1, { ocrStatus: 'processing' }));
    await resetStaleOcr();
    expect((await db.pages.get('p1'))?.ocrStatus).toBe('pending');
  });
});
