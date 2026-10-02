import { franc } from 'franc-min';
import { getOcrLanguage } from '@/lib/ocr-languages';

const MIN_LENGTH = 20;

// franc reports ISO 639-3 individual languages; Tesseract mostly uses the same codes,
// but names a few by their macrolanguage or script variant.
const FRANC_TO_TESSERACT: Record<string, string> = {
  cmn: 'chi_sim',
  arb: 'ara',
  azj: 'aze',
  npi: 'nep',
  pbu: 'pus',
  pes: 'fas',
  swh: 'swa',
  uzn: 'uzb',
  zlm: 'msa',
};

/** ISO 639-3 code of the text's language, or undefined if it's too short or unclear. */
export function detectLanguage(text: string): string | undefined {
  const trimmed = text.replace(/\s+/g, ' ').trim();
  if (trimmed.length < MIN_LENGTH) return undefined;
  const code = franc(trimmed, { minLength: MIN_LENGTH });
  return code === 'und' ? undefined : code;
}

/** Tesseract traineddata for a franc language code, if Tesseract supports it. */
export function toTesseractLanguage(code: string): string | undefined {
  const mapped = FRANC_TO_TESSERACT[code] ?? code;
  return getOcrLanguage(mapped) ? mapped : undefined;
}

/** Detect the language of recognized text as a Tesseract language code. */
export function detectOcrLanguage(text: string): string | undefined {
  const code = detectLanguage(text);
  return code ? toTesseractLanguage(code) : undefined;
}
