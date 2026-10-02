import { describe, it, expect } from 'vitest';
import { sanitizeWinAnsi, wordToPdfPlacement, pagesToPdfInput } from '@/lib/pdf';
import type { OcrWord, Page } from '@/types';

const measure = (text: string, size: number) => text.length * size * 0.5;

function word(text: string, x0: number, y0: number, x1: number, y1: number): OcrWord {
  return { text, bbox: { x0, y0, x1, y1 }, confidence: 90 };
}

describe('sanitizeWinAnsi', () => {
  it('keeps ASCII and German umlauts', () => {
    expect(sanitizeWinAnsi('Größe: 12,50 €')).toBe('Größe: 12,50 €');
  });

  it('drops characters Helvetica cannot encode', () => {
    expect(sanitizeWinAnsi('Łódź → 日本')).toBe('ód  ');
    expect(sanitizeWinAnsi('tab\there')).toBe('tabhere');
  });
});

describe('wordToPdfPlacement', () => {
  it('flips y so the word lands at the same spot in PDF coordinates', () => {
    const p = wordToPdfPlacement(word('Invoice', 100, 50, 240, 70), 1000, measure)!;
    expect(p.x).toBe(100);
    expect(p.size).toBe(20);
    // bbox bottom is 70px from the top -> 930pt from the bottom, baseline raised 20% of height
    expect(p.y).toBeCloseTo(934);
  });

  it('scales glyphs horizontally to span the bbox width', () => {
    // natural width = 7 chars * 20 * 0.5 = 70; bbox is 140 wide -> 200%
    const p = wordToPdfPlacement(word('Invoice', 100, 50, 240, 70), 1000, measure)!;
    expect(p.horizontalScale).toBeCloseTo(200);
  });

  it('returns null for empty or degenerate words', () => {
    expect(wordToPdfPlacement(word('日本', 0, 0, 10, 10), 100, measure)).toBeNull();
    expect(wordToPdfPlacement(word('a', 10, 10, 10, 20), 100, measure)).toBeNull();
  });
});

describe('pagesToPdfInput', () => {
  const base = {
    documentId: 'd',
    pageNumber: 1,
    originalBlob: new Blob(['o']),
    filter: 'original' as const,
    createdAt: new Date(),
  };

  it('includes words only when OCR is done for the current image', () => {
    const words = [word('Hi', 0, 0, 10, 10)];
    const pages: Page[] = [
      { ...base, id: 'a', ocrStatus: 'done', ocrWords: words },
      { ...base, id: 'b', ocrStatus: 'pending', ocrWords: words },
    ];
    const input = pagesToPdfInput(pages);
    expect(input[0].words).toBe(words);
    expect(input[1].words).toBeUndefined();
  });
});
