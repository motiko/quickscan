/**
 * Frame analyzer — evaluates video frame quality and provides user-facing hints.
 *
 * Runs every ~120ms on mobile, so performance matters.
 * Uses integer-only luminance: `(R*77 + G*150 + B*29) >> 8`
 */

import type { DetectionHint, FrameAnalysis } from '@/types';

/** Brightness thresholds */
const DARK_THRESHOLD = 60;
const BRIGHT_THRESHOLD = 240;

/** Contrast threshold (standard deviation of luminance) */
const CONTRAST_THRESHOLD = 25;

/**
 * Analyze a video frame for environmental quality.
 *
 * Computes average brightness (luminance) and contrast (std-dev of luminance),
 * then returns boolean flags and a prioritized user-facing hint.
 *
 * For performance, luminance std-dev is computed by sampling every 4th pixel.
 */
export function analyzeFrame(imageData: ImageData): FrameAnalysis {
  const { data } = imageData;
  const pixelCount = data.length / 4;

  // --- Pass 1: average brightness (every pixel) ---
  let brightnessSum = 0;
  for (let i = 0; i < data.length; i += 4) {
    brightnessSum += (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }
  const brightness = brightnessSum / pixelCount;

  // --- Pass 2: contrast as std-dev of luminance (every 4th pixel) ---
  const step = 4; // sample every 4th pixel
  let sumSqDiff = 0;
  let sampleCount = 0;
  for (let i = 0; i < data.length; i += 4 * step) {
    const lum = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
    const diff = lum - brightness;
    sumSqDiff += diff * diff;
    sampleCount++;
  }
  const contrast = Math.sqrt(sumSqDiff / sampleCount);

  // --- Flags ---
  const isTooDark = brightness < DARK_THRESHOLD;
  const isTooBright = brightness > BRIGHT_THRESHOLD;
  const isLowContrast = contrast < CONTRAST_THRESHOLD;

  // --- Hint (priority order: dark > bright > low contrast) ---
  let hint: DetectionHint = null;
  if (isTooDark) {
    hint = 'too_dark';
  } else if (isTooBright) {
    hint = 'too_bright';
  } else if (isLowContrast) {
    hint = 'low_contrast';
  }

  return { brightness, contrast, isTooDark, isTooBright, isLowContrast, hint };
}

/** Map a detection hint to a user-facing guidance string. */
export function getHintMessage(hint: DetectionHint): string {
  switch (hint) {
    case 'too_dark':
      return 'Too dark — try turning on flash';
    case 'too_bright':
      return 'Too bright — reduce glare';
    case 'low_contrast':
      return 'Low contrast — use a darker surface';
    case 'hold_steady':
      return 'Hold steady...';
    case 'move_closer':
      return 'Move closer to the document';
    case 'move_further':
      return 'Move further from the document';
    case 'align_document':
      return 'Align document inside frame';
    case null:
      return '';
  }
}
