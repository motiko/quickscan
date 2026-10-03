import type { OcrResult } from '@/lib/ocr';

/**
 * Finds a page's upright orientation from OCR quality alone, so an upside-down or sideways
 * scan still gets its text (and is turned upright) without Tesseract's OSD model, which needs
 * the legacy engine and a ~10 MB download. Recognizing text the wrong way round gives
 * confidence in the 20s–50s and almost no confident words; upright text gives 80+.
 * Only a poor first pass pays for the extra passes.
 */

export type Rotation = 0 | 90 | 180 | 270;

/** Below this overall confidence the first pass may be the wrong way round. */
export const PROBE_BELOW_CONFIDENCE = 60;
/** A rotated pass must be at least this confident overall... */
const ACCEPT_CONFIDENCE = 60;
/** ...and have at least this many characters in confident words. */
const ACCEPT_MIN_CHARS = 20;
const CONFIDENT_WORD = 70;

// Upside down first (the most common mistake with a portrait page), then sideways
const PROBE_ORDER: Exclude<Rotation, 0>[] = [180, 90, 270];

/** Characters in words the engine is confident about and that look like words (2+ letters/digits). */
export function confidentChars(result: OcrResult): number {
  let chars = 0;
  for (const word of result.words) {
    if (word.confidence >= CONFIDENT_WORD && /[\p{L}\p{N}]{2,}/u.test(word.text)) chars += word.text.length;
  }
  return chars;
}

export function needsOrientationProbe(result: OcrResult): boolean {
  return result.confidence < PROBE_BELOW_CONFIDENCE;
}

/** Whether a pass on the rotated image is clearly better than the pass as scanned. */
export function isClearlyBetter(rotated: OcrResult, asScanned: OcrResult): boolean {
  const chars = confidentChars(rotated);
  return (
    rotated.confidence >= ACCEPT_CONFIDENCE &&
    chars >= ACCEPT_MIN_CHARS &&
    chars >= 2 * confidentChars(asScanned) &&
    rotated.confidence > asScanned.confidence
  );
}

export interface UprightResult {
  result: OcrResult;
  /** Clockwise rotation applied to the image to get `result`; 0 when it was upright. */
  rotation: Rotation;
  /** The rotated image when `rotation` isn't 0; `result`'s word boxes refer to it. */
  image?: Blob;
}

/**
 * Recognize `image`, and if the text looks wrong-way-round, try the other orientations and
 * keep the first that's clearly better. A failure while probing keeps the first pass.
 */
export async function recognizeUpright(
  image: Blob,
  recognize: (image: Blob) => Promise<OcrResult>,
  rotate: (image: Blob, degrees: Exclude<Rotation, 0>) => Promise<Blob>
): Promise<UprightResult> {
  const asScanned = await recognize(image);
  if (!needsOrientationProbe(asScanned)) return { result: asScanned, rotation: 0 };

  for (const degrees of PROBE_ORDER) {
    try {
      const rotated = await rotate(image, degrees);
      const result = await recognize(rotated);
      if (isClearlyBetter(result, asScanned)) return { result, rotation: degrees, image: rotated };
    } catch (err) {
      console.warn('Orientation probe failed:', err);
      break;
    }
  }
  return { result: asScanned, rotation: 0 };
}
