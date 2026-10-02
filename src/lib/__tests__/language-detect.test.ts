import { describe, it, expect } from 'vitest';
import { detectLanguage, detectOcrLanguage, toTesseractLanguage } from '@/lib/language-detect';

const GERMAN =
  'Sehr geehrte Damen und Herren, anbei erhalten Sie die Rechnung für die gelieferten Waren. Bitte überweisen Sie den Betrag innerhalb von vierzehn Tagen.';
const ENGLISH =
  'Dear Sir or Madam, please find attached the invoice for the goods delivered last week. Kindly pay the amount within fourteen days.';

describe('detectLanguage', () => {
  it('detects German and English text', () => {
    expect(detectLanguage(GERMAN)).toBe('deu');
    expect(detectLanguage(ENGLISH)).toBe('eng');
  });

  it('returns undefined for short or empty text', () => {
    expect(detectLanguage('')).toBeUndefined();
    expect(detectLanguage('Rechnung 2026')).toBeUndefined();
    expect(detectLanguage('   \n  a  \n ')).toBeUndefined();
  });
});

describe('toTesseractLanguage', () => {
  it('keeps codes Tesseract shares with franc', () => {
    expect(toTesseractLanguage('deu')).toBe('deu');
    expect(toTesseractLanguage('fra')).toBe('fra');
  });

  it('maps individual languages to Tesseract traineddata names', () => {
    expect(toTesseractLanguage('cmn')).toBe('chi_sim');
    expect(toTesseractLanguage('zlm')).toBe('msa');
    expect(toTesseractLanguage('pes')).toBe('fas');
    expect(toTesseractLanguage('arb')).toBe('ara');
    expect(toTesseractLanguage('swh')).toBe('swa');
  });

  it('returns undefined for languages Tesseract lacks', () => {
    expect(toTesseractLanguage('hau')).toBeUndefined();
  });
});

describe('detectOcrLanguage', () => {
  it('returns a Tesseract code', () => {
    expect(detectOcrLanguage(GERMAN)).toBe('deu');
    expect(detectOcrLanguage('这是一个用中文写的句子，用于测试语言检测功能。我们希望它能正确识别。')).toBe('chi_sim');
  });
});
