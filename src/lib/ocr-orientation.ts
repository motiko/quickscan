import type { OcrResult } from '@/lib/ocr';
import type { OcrWord } from '@/types';

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

/** Word boxes of an image of `size`, moved onto the same image turned clockwise by `rotation`. */
export function rotateWords(words: OcrWord[], size: { width: number; height: number }, rotation: Rotation): OcrWord[] {
  const { width: w, height: h } = size;
  return words.map((word) => {
    const { x0, y0, x1, y1 } = word.bbox;
    const bbox =
      rotation === 90
        ? { x0: h - y1, y0: x0, x1: h - y0, y1: x1 }
        : rotation === 180
          ? { x0: w - x1, y0: h - y1, x1: w - x0, y1: h - y0 }
          : rotation === 270
            ? { x0: y0, y0: w - x1, x1: y1, y1: w - x0 }
            : word.bbox;
    return { ...word, bbox };
  });
}

/**
 * An engine that reports the page's orientation (Apple Vision): turn its words with the page
 * when it isn't upright and there's enough text to trust the direction (a sideways label on a
 * photo shouldn't turn it). No extra passes.
 */
export function uprightFromEngine(result: OcrResult): UprightResult {
  const rotation = result.uprightRotation ?? 0;
  const letters = result.text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (rotation === 0 || !result.imageSize || letters < ACCEPT_MIN_CHARS) return { result, rotation: 0 };
  return {
    result: { ...result, words: rotateWords(result.words, result.imageSize, rotation) },
    rotation,
    unrotated: result,
  };
}

export interface UprightResult {
  result: OcrResult;
  /** Clockwise rotation applied to the image to get `result`; 0 when it was upright. */
  rotation: Rotation;
  /** The rotated image when `rotation` isn't 0; `result`'s word boxes refer to it. */
  image?: Blob;
  /** The pass on the image as scanned, when `rotation` isn't 0 (to fall back on if turning the page fails). */
  unrotated?: OcrResult;
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
      if (isClearlyBetter(result, asScanned)) return { result, rotation: degrees, image: rotated, unrotated: asScanned };
    } catch (err) {
      console.warn('Orientation probe failed:', err);
      break;
    }
  }
  return { result: asScanned, rotation: 0 };
}
