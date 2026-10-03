import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OcrResult } from '@/lib/ocr';

vi.mock('@/lib/ocr', () => ({ recognize: vi.fn() }));
vi.mock('@/lib/image-processing', () => ({
  // A "rotated" image is the original's text plus the turn, so the fake recognizer can tell them apart
  rotateImage: vi.fn(async (blob: Blob, degrees: number) => new Blob([`${await blob.text()}@${degrees}`])),
  createThumbnail: vi.fn(async () => new Blob(['thumb'])),
  fitImage: vi.fn(async (blob: Blob) => ({ blob, scale: 1 })),
}));
vi.mock('@/lib/annotations/flatten', () => ({
  getImageSize: vi.fn(async () => ({ width: 600, height: 800 })),
  getRenderedBlob: vi.fn(async (page: { processedBlob?: Blob }) => page.processedBlob),
}));

import { db } from '@/lib/db';
import { recognize } from '@/lib/ocr';
import { confidentChars, isClearlyBetter, recognizeUpright } from '@/lib/ocr-orientation';
import { keepPageOrientation, processPendingOcr, requeueAllOcr, resetStaleOcr, retryOcr } from '@/lib/ocr-queue';
import { getImageSize } from '@/lib/annotations/flatten';
import { applyUntracked, readOutbox } from '@/lib/outbox';
import { savePageAnnotations, updatePage } from '@/hooks/useDocuments';
import type { Annotation, Page } from '@/types';

// Measured with Tesseract (eng) on a rendered invoice: upright 94 % with 37 confident words,
// upside down 26 % with 4, sideways 54 % with none.
const word = (text: string, confidence: number) => ({ text, confidence, bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } });
const upright: OcrResult = {
  text: 'Invoice 2026-0042 Total amount due 553.95',
  confidence: 94,
  words: ['Invoice', '2026-0042', 'Total', 'amount', 'due', '553.95'].map((t) => word(t, 95)),
};
const upsideDown: OcrResult = {
  text: '*a]ep 92I0AUl BY} JO SAep',
  confidence: 26,
  words: [word('*a]ep', 30), word('92I0AUl', 40), word('JO', 75), word('SAep', 20)],
};
const blank: OcrResult = { text: '', confidence: 0, words: [] };

describe('isClearlyBetter', () => {
  it('accepts a confident rotated pass over a garbled one', () => {
    expect(confidentChars(upsideDown)).toBe(2);
    expect(isClearlyBetter(upright, upsideDown)).toBe(true);
  });

  it('rejects a rotated pass with too little confident text', () => {
    const little: OcrResult = { text: 'ok', confidence: 70, words: [word('ok', 90)] };
    expect(isClearlyBetter(little, blank)).toBe(false);
  });
});

describe('recognizeUpright', () => {
  const rotate = vi.fn(async (_b: Blob, d: number) => new Blob([String(d)]));

  beforeEach(() => rotate.mockClear());

  it('does no extra passes when the page reads fine as scanned', async () => {
    const rec = vi.fn(async () => upright);
    const out = await recognizeUpright(new Blob(['0']), rec, rotate);
    expect(out.rotation).toBe(0);
    expect(rec).toHaveBeenCalledTimes(1);
    expect(rotate).not.toHaveBeenCalled();
  });

  it('turns an upside-down page around', async () => {
    const rec = vi.fn(async (b: Blob) => ((await b.text()) === '180' ? upright : upsideDown));
    const out = await recognizeUpright(new Blob(['0']), rec, rotate);
    expect(out.rotation).toBe(180);
    expect(out.result).toBe(upright);
    expect(await out.image?.text()).toBe('180');
    expect(rec).toHaveBeenCalledTimes(2);
  });

  it('finds a sideways page', async () => {
    const rec = vi.fn(async (b: Blob) => ((await b.text()) === '270' ? upright : upsideDown));
    const out = await recognizeUpright(new Blob(['0']), rec, rotate);
    expect(out.rotation).toBe(270);
    expect(rec).toHaveBeenCalledTimes(4);
  });

  it('keeps a page without text as it is', async () => {
    const out = await recognizeUpright(new Blob(['0']), async () => blank, rotate);
    expect(out).toEqual({ result: blank, rotation: 0 });
  });

  it('keeps the first pass when rotating fails', async () => {
    const failing = vi.fn(async () => {
      throw new Error('no canvas');
    });
    const out = await recognizeUpright(new Blob(['0']), async () => upsideDown, failing);
    expect(out).toEqual({ result: upsideDown, rotation: 0 });
  });
});

describe('processPendingOcr orientation', () => {
  const mockRecognize = vi.mocked(recognize);
  const mockSize = vi.mocked(getImageSize);
  const rect: Annotation = { id: 'a1', type: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: '#f00', width: 0.01 };
  const docUpdatedAt = new Date('2026-01-01T00:00:00Z');
  let n = 0;
  let id: string;

  async function addPage(overrides: Partial<Page> = {}) {
    const now = new Date();
    await db.pages.add({
      id, documentId: 'doc1', pageNumber: 1, originalBlob: new Blob(['img']), processedBlob: new Blob(['img']),
      filter: 'original', createdAt: now, updatedAt: now, ocrStatus: 'pending', annotations: [rect],
      ...overrides,
    });
    // Only what the OCR queue writes is of interest
    await db.outbox.clear();
  }
  const page = () => db.pages.get(id);
  const image = async () => (await page())?.processedBlob?.text();

  beforeEach(async () => {
    id = `p${++n}`;
    mockRecognize.mockReset();
    mockSize.mockReset();
    mockSize.mockResolvedValue({ width: 600, height: 800 });
    // The scanned image reads upside down; only the 180° turn reads upright
    mockRecognize.mockImplementation(async (b: Blob) => ((await b.text()) === 'img@180' ? upright : upsideDown));
    await db.delete();
    await db.open();
    await db.documents.add({ id: 'doc1', name: 'Scan', createdAt: docUpdatedAt, updatedAt: docUpdatedAt, pageCount: 1 });
  });

  it('stores an upside-down page upright, with its text, turned annotations and thumbnail', async () => {
    await addPage();
    await processPendingOcr();

    const p = await page();
    expect(p?.ocrStatus).toBe('done');
    expect(p?.ocrText).toBe(upright.text);
    expect(await image()).toBe('img@180');
    const turned = p?.annotations?.[0];
    expect(turned).toMatchObject({ type: 'rect' });
    if (turned?.type === 'rect') {
      expect(turned.x).toBeCloseTo(0.6);
      expect(turned.y).toBeCloseTo(0.7);
    }
    expect(await (await db.documents.get('doc1'))?.thumbnailBlob?.text()).toBe('thumb');
  });

  it('queues the turned image for upload', async () => {
    await addPage();
    await processPendingOcr();

    // Only the page: the search text is derived and local, so rebuilding it queues no document
    expect(await readOutbox()).toEqual([expect.objectContaining({ kind: 'page', id, op: 'upsert', fileChanged: true })]);
  });

  it('refreshes the thumbnail without touching the document (no document edit to sync)', async () => {
    await addPage();
    await processPendingOcr();

    const doc = await db.documents.get('doc1');
    expect(await doc?.thumbnailBlob?.text()).toBe('thumb');
    expect(doc?.updatedAt).toEqual(docUpdatedAt);
  });

  it('leaves a page the user turned by hand as it is', async () => {
    await addPage();
    await keepPageOrientation(id);
    await processPendingOcr();

    expect(await image()).toBe('img');
    expect((await page())?.ocrText).toBe(upsideDown.text);
  });

  it('remembers a page turned by hand across a reload', async () => {
    await addPage();
    // The user turns it (updatePage) and the tab closes while it's being recognized
    await updatePage(id, { processedBlob: new Blob(['img']) });
    await db.pages.update(id, { ocrStatus: 'processing' });
    db.close();
    await db.open();
    await resetStaleOcr();
    await processPendingOcr();

    const p = await page();
    expect(p?.keepOrientation).toBe(true);
    expect(await image()).toBe('img');
    expect(p?.ocrText).toBe(upsideDown.text);
    // The flag is local: the outbox has the user's turn (a new image), nothing else
    expect(await readOutbox()).toEqual([expect.objectContaining({ kind: 'page', id, fileChanged: true })]);
  });

  it('never turns an image downloaded from another device, even where the original is', async () => {
    // What a sync download leaves on the capturing device: the original, another device's image
    await addPage();
    await applyUntracked(() => db.pages.update(id, { processedBlob: new Blob(['img']), keepOrientation: true }));
    await processPendingOcr();

    expect(await image()).toBe('img');
    expect((await page())?.ocrText).toBe(upsideDown.text);
  });

  it('keeps a finished recognition when the annotations change meanwhile, and turns the new ones', async () => {
    const circle: Annotation = { ...rect, id: 'a2', x: 0.5, y: 0.5 };
    mockRecognize.mockImplementation(async (b: Blob) => {
      const text = await b.text();
      if (mockRecognize.mock.calls.length === 1) await savePageAnnotations(id, [circle]);
      return text === 'img@180' ? upright : upsideDown;
    });
    await addPage();
    await processPendingOcr();

    const p = await page();
    expect(p?.ocrStatus).toBe('done');
    expect(p?.ocrText).toBe(upright.text);
    expect(await image()).toBe('img@180');
    // Not thrown away and recognized again: the upright pass and the first one only
    expect(mockRecognize).toHaveBeenCalledTimes(2);
    expect(p?.annotations).toEqual([expect.objectContaining({ id: 'a2' })]);
    const turned = p?.annotations?.[0];
    if (turned?.type === 'rect') expect(turned.x).toBeCloseTo(0.2);
  });

  it('recognizes again when the image is swapped for one of the same size during recognition', async () => {
    let swapped = false;
    mockRecognize.mockImplementation(async () => {
      if (!swapped) {
        swapped = true;
        await applyUntracked(() => db.pages.update(id, { processedBlob: new Blob(['imh']) }));
      }
      return upsideDown;
    });
    await addPage({ keepOrientation: true });
    await processPendingOcr();

    expect(await image()).toBe('imh');
    expect(mockRecognize).toHaveBeenCalledTimes(2);
    expect((await page())?.ocrStatus).toBe('done');
  });

  it('never turns a page pulled from another device (no original)', async () => {
    await addPage({ originalBlob: undefined });
    await processPendingOcr();

    expect(await image()).toBe('img');
    expect((await page())?.ocrText).toBe(upsideDown.text);
    expect(await readOutbox()).toEqual([expect.objectContaining({ kind: 'page', id, fileChanged: false })]);
  });

  it('never turns a page on a re-run of recognized text', async () => {
    await addPage({
      ocrStatus: 'done',
      ocrText: 'old',
      ocrInfo: { engine: 'tesseract', languages: ['eng'], confidence: 30, recognizedAt: new Date() },
    });
    await retryOcr(id);

    expect(await image()).toBe('img');
    expect((await page())?.ocrText).toBe(upsideDown.text);
  });

  it('never turns a page when recognition is retried after an error', async () => {
    await addPage({ ocrStatus: 'error' });
    await retryOcr(id);

    expect(await image()).toBe('img');
    expect((await page())?.ocrStatus).toBe('done');
  });

  it('never turns a page re-queued for a language change', async () => {
    await addPage({ ocrStatus: 'done', ocrText: 'old' });
    await requeueAllOcr();

    expect(await image()).toBe('img');
  });

  it('does not write a turn over an image sync swapped in during recognition', async () => {
    let swapped = false;
    mockRecognize.mockImplementation(async (b: Blob) => {
      const text = await b.text();
      if (!swapped) {
        swapped = true;
        // A download stored without tracking (and without a status reset)
        await applyUntracked(() => db.pages.update(id, { processedBlob: new Blob(['downloaded image']) }));
      }
      return text === 'img@180' ? upright : upsideDown;
    });
    await addPage();
    await processPendingOcr();

    expect(await image()).toBe('downloaded image');
    // The new image was recognized instead
    expect(mockRecognize.mock.calls.some(([b]) => b.size === 'downloaded image'.length)).toBe(true);
    expect((await page())?.ocrStatus).toBe('done');
  });

  it('does not write a turn over an image the user changed while the size was measured', async () => {
    mockSize.mockImplementationOnce(async () => {
      await updatePage(id, { processedBlob: new Blob(['user edit']) });
      return { width: 600, height: 800 };
    });
    await addPage();
    await processPendingOcr();

    expect(await image()).toBe('user edit');
    expect((await page())?.annotations).toEqual([rect]);
    expect((await page())?.ocrStatus).toBe('done');
  });

  it('writes nothing for a page deleted mid-recognition', async () => {
    mockSize.mockImplementationOnce(async () => {
      // Removed by sync (untracked), so any entry in the outbox would come from the OCR queue
      await applyUntracked(() => db.pages.delete(id));
      return { width: 600, height: 800 };
    });
    await addPage();
    await processPendingOcr();

    expect(await page()).toBeUndefined();
    expect(await readOutbox()).toEqual([]);
    expect((await db.documents.get('doc1'))?.updatedAt).toEqual(docUpdatedAt);
  });

  it('keeps the page as scanned, with its text, when turning it fails', async () => {
    mockSize.mockRejectedValueOnce(new Error('decode failed'));
    await addPage();
    await processPendingOcr();

    const p = await page();
    expect(await image()).toBe('img');
    expect(p?.annotations).toEqual([rect]);
    expect(p?.ocrStatus).toBe('done');
    expect(p?.ocrText).toBe(upsideDown.text);
  });

  it('does not mark a page as failed when its image changed before recognition failed', async () => {
    mockRecognize.mockImplementationOnce(async () => {
      await updatePage(id, { processedBlob: new Blob(['user edit']) });
      throw new Error('worker crashed');
    });
    await addPage();
    await processPendingOcr();

    // Re-queued by updatePage and recognized again, not left as 'error'
    expect((await page())?.ocrStatus).toBe('done');
    expect(await image()).toBe('user edit');
  });
});
