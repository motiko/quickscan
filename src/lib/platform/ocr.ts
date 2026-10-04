import { recognize as recognizeWithTesseract, type OcrResult } from '@/lib/ocr';
import { isNativeApp } from '@/lib/native-passkey';
import type { DeviceOcrEngine } from '@/types';

/**
 * Text recognition on the device. The web (and the app, as a fallback) uses Tesseract
 * (`ocr.ts`); the iOS app uses Apple Vision through capacitor-native-ocr (`native/ocr.ts`).
 * Word boxes are in pixels of the image passed in, confidence is 0–100 as in Tesseract.
 */
export interface OcrProvider {
  engine: DeviceOcrEngine;
  /** `langs` are Tesseract codes (`eng`, `deu`), as the OCR languages setting stores them. */
  recognize(image: Blob, langs: string[]): Promise<OcrResult>;
}

export const tesseractOcr: OcrProvider = { engine: 'tesseract', recognize: recognizeWithTesseract };

/**
 * The provider for a page in these languages: the native engine inside the app when it's
 * available and reads every one of them, Tesseract otherwise (the web, an older OS, or a
 * language Vision doesn't have — Tesseract has far more).
 */
export async function ocrProviderFor(langs: string[]): Promise<OcrProvider> {
  if (!isNativeApp()) return tesseractOcr;
  try {
    const native = await import('@/lib/platform/native/ocr');
    if (await native.canRecognize(langs)) return native.nativeOcr;
  } catch (err) {
    console.warn('Native OCR unavailable; using Tesseract:', err);
  }
  return tesseractOcr;
}
