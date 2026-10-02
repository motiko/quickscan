import { describe, expect, it } from 'vitest';

import { analyzeFrame, getHintMessage } from '@/lib/frame-analyzer';

/** Helper to build a uniform-color ImageData. */
function createImageData(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

describe('analyzeFrame', () => {
  it('detects too dark frame', () => {
    const frame = createImageData(10, 10, 20, 20, 20);
    const result = analyzeFrame(frame);

    expect(result.isTooDark).toBe(true);
    expect(result.hint).toBe('too_dark');
  });

  it('detects too bright frame', () => {
    const frame = createImageData(10, 10, 250, 250, 250);
    const result = analyzeFrame(frame);

    expect(result.isTooBright).toBe(true);
    expect(result.hint).toBe('too_bright');
  });

  it('detects low contrast', () => {
    // Half pixels (128,128,128), half pixels (135,135,135)
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    const half = (width * height) / 2;
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      const val = p < half ? 128 : 135;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
    const frame = { data, width, height, colorSpace: 'srgb' } as ImageData;
    const result = analyzeFrame(frame);

    expect(result.isLowContrast).toBe(true);
    expect(result.hint).toBe('low_contrast');
  });

  it('normal frame has no hint', () => {
    // Use a frame with enough contrast — alternate black and white rows
    const width = 10;
    const height = 10;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let p = 0; p < width * height; p++) {
      const i = p * 4;
      const row = Math.floor(p / width);
      const val = row % 2 === 0 ? 80 : 200;
      data[i] = val;
      data[i + 1] = val;
      data[i + 2] = val;
      data[i + 3] = 255;
    }
    const frame = { data, width, height, colorSpace: 'srgb' } as ImageData;
    const result = analyzeFrame(frame);

    expect(result.isTooDark).toBe(false);
    expect(result.isTooBright).toBe(false);
    expect(result.isLowContrast).toBe(false);
    expect(result.hint).toBeNull();
  });

  it('brightness calculation is correct', () => {
    // For uniform (100, 150, 200): luminance = (100*77 + 150*150 + 200*29) >> 8
    // = (7700 + 22500 + 5800) >> 8 = 36000 >> 8 = 140
    const frame = createImageData(10, 10, 100, 150, 200);
    const result = analyzeFrame(frame);

    expect(result.brightness).toBe(140);
  });

  it('too_dark takes priority over low_contrast', () => {
    // A very dark frame will also have low contrast (all pixels near zero)
    const frame = createImageData(10, 10, 10, 10, 10);
    const result = analyzeFrame(frame);

    expect(result.isTooDark).toBe(true);
    expect(result.isLowContrast).toBe(true);
    expect(result.hint).toBe('too_dark');
  });
});

describe('getHintMessage', () => {
  it('returns correct strings', () => {
    expect(getHintMessage('too_dark')).toBe('Too dark — try turning on flash');
    expect(getHintMessage('too_bright')).toBe('Too bright — reduce glare');
    expect(getHintMessage('low_contrast')).toBe(
      'Low contrast — use a darker surface',
    );
    expect(getHintMessage('hold_steady')).toBe('Hold steady...');
    expect(getHintMessage('move_closer')).toBe(
      'Move closer to the document',
    );
    expect(getHintMessage('move_further')).toBe(
      'Move further from the document',
    );
    expect(getHintMessage('align_document')).toBe(
      'Align document inside frame',
    );
    expect(getHintMessage(null)).toBe('');
  });
});
