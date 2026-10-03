import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { OcrResult } from '@/lib/ocr';

vi.mock('@/lib/ocr', () => ({ recognize: vi.fn() }));
vi.mock('@/lib/image-processing', () => ({
  // A "rotated" image is the original's text plus the turn, so the fake recognizer can tell them apart
  rotateImage: vi.fn(async (blob: Blob, degrees: number) => new Blob([`${await blob.text()}@${degrees}`])),
  createThumbnail: vi.fn(async () => new Blob(['thumb'])),
}));
vi.mock('@/lib/annotations/flatten', () => ({
  getImageSize: vi.fn(async () => ({ width: 600, height: 800 })),
  getRenderedBlob: vi.fn(async (page: { processedBlob?: Blob }) => page.processedBlob),
}));

import { db } from '@/lib/db';
import { recognize } from '@/lib/ocr';
import { confidentChars, isClearlyBetter, recognizeUpright } from '@/lib/ocr-orientation';
import { keepPageOrientation, processPendingOcr } from '@/lib/ocr-queue';

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

  beforeEach(async () => {
    mockRecognize.mockReset();
    // The scanned image reads upside down; only the 180° turn reads upright
    mockRecognize.mockImplementation(async (b: Blob) => ((await b.text()) === 'img@180' ? upright : upsideDown));
    await db.delete();
    await db.open();
    const now = new Date();
    await db.documents.add({ id: 'doc1', name: 'Scan', createdAt: now, updatedAt: now, pageCount: 1 });
    await db.pages.add({
      id: 'p1', documentId: 'doc1', pageNumber: 1, processedBlob: new Blob(['img']), filter: 'original',
      createdAt: now, updatedAt: now, ocrStatus: 'pending',
      annotations: [{ id: 'a1', type: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.1, color: '#f00', width: 0.01 }],
    });
  });

  it('stores an upside-down page upright, with its text, turned annotations and thumbnail', async () => {
    await processPendingOcr();

    const page = await db.pages.get('p1');
    expect(page?.ocrStatus).toBe('done');
    expect(page?.ocrText).toBe(upright.text);
    expect(await page?.processedBlob?.text()).toBe('img@180');
    const rect = page?.annotations?.[0];
    expect(rect).toMatchObject({ type: 'rect' });
    if (rect?.type === 'rect') {
      expect(rect.x).toBeCloseTo(0.6);
      expect(rect.y).toBeCloseTo(0.7);
    }
    expect(await (await db.documents.get('doc1'))?.thumbnailBlob?.text()).toBe('thumb');
  });

  it('leaves a page the user turned by hand as it is', async () => {
    keepPageOrientation('p1');
    await processPendingOcr();

    const page = await db.pages.get('p1');
    expect(await page?.processedBlob?.text()).toBe('img');
    expect(page?.ocrText).toBe(upsideDown.text);
  });
});
