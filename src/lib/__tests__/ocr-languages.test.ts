import { describe, it, expect } from 'vitest';
import { OCR_LANGUAGES, filterOcrLanguages, getOcrLanguage } from '@/lib/ocr-languages';

const codes = (query: string) => filterOcrLanguages(query).map((l) => l.code);

describe('OCR_LANGUAGES', () => {
  it('has unique codes', () => {
    expect(new Set(OCR_LANGUAGES.map((l) => l.code)).size).toBe(OCR_LANGUAGES.length);
  });

  it('includes non-Latin scripts', () => {
    for (const code of ['rus', 'heb', 'chi_sim', 'chi_tra', 'ara', 'jpn', 'kor']) {
      expect(getOcrLanguage(code)).toBeDefined();
    }
  });
});

describe('filterOcrLanguages', () => {
  it('returns everything for an empty query', () => {
    expect(filterOcrLanguages('  ')).toHaveLength(OCR_LANGUAGES.length);
  });

  it('matches English names case-insensitively', () => {
    expect(codes('HEBR')).toEqual(['heb']);
    expect(codes('chinese')).toEqual(['chi_sim', 'chi_tra']);
  });

  it('matches native names in their own script', () => {
    expect(codes('русск')).toEqual(['rus']);
    expect(codes('עברית')).toEqual(['heb']);
    expect(codes('中文')).toEqual(['chi_sim', 'chi_tra']);
  });

  it('ignores accents', () => {
    expect(codes('espanol')).toEqual(['spa']);
  });

  it('matches language codes', () => {
    expect(codes('deu')).toEqual(['deu']);
  });

  it('returns nothing when no language matches', () => {
    expect(codes('klingon')).toEqual([]);
  });
});
