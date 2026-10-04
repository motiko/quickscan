import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecognizeResult } from 'capacitor-native-ocr';

// Like Capacitor's registerPlugin: a proxy that turns every property, `then` included, into a
// native call. The native side has no "then" method, so that call never answers.
const calls: { method: string; args: unknown[] }[] = [];
const answers: Record<string, unknown> = {};
vi.mock('capacitor-native-ocr', () => ({
  NativeOcr: new Proxy(
    {},
    {
      get: (_, prop) => (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        const answer = answers[String(prop)];
        return answer === undefined ? new Promise(() => {}) : Promise.resolve(answer);
      },
    }
  ),
}));

const { canRecognize, nativeOcr, toNativeLanguages, toOcrResult } = await import('@/lib/platform/native/ocr');

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

const result: RecognizeResult = {
  text: 'Total 12,50\n\nDanke',
  imageSize: { width: 1000, height: 2000 },
  rotation: 180,
  blocks: [
    {
      text: 'Total 12,50',
      box: box(0.1, 0.1, 0.5, 0.02),
      lines: [
        {
          text: 'Total 12,50',
          box: box(0.1, 0.1, 0.5, 0.02),
          confidence: 1,
          words: [
            { text: 'Total', box: box(0.1, 0.1, 0.2, 0.02), confidence: 1 },
            { text: '12,50', box: box(0.4, 0.1, 0.2, 0.02), confidence: 1 },
          ],
        },
      ],
    },
    {
      text: 'Danke',
      box: box(0.1, 0.5, 0.3, 0.02),
      lines: [
        {
          text: 'Danke',
          box: box(0.1, 0.5, 0.3, 0.02),
          confidence: 0.5,
          words: [{ text: 'Danke', box: box(0.1, 0.5, 0.3, 0.02), confidence: 0.5 }],
        },
      ],
    },
  ],
};

beforeEach(() => {
  calls.length = 0;
});

describe('native OCR provider', () => {
  it('maps Tesseract codes to the engine’s languages, all or nothing', () => {
    const available = ['en-US', 'de-DE', 'zh-Hant'];
    expect(toNativeLanguages(['deu', 'eng'], available)).toEqual(['de-DE', 'en-US']);
    expect(toNativeLanguages(['chi_tra'], available)).toEqual(['zh-Hant']);
    expect(toNativeLanguages(['chi_sim'], available)).toBeUndefined();
    expect(toNativeLanguages(['eng', 'heb'], available)).toBeUndefined();
  });

  it('turns normalized boxes into pixels and confidence into 0–100', () => {
    const ocr = toOcrResult(result);

    expect(ocr.text).toBe('Total 12,50\n\nDanke');
    expect(ocr.words).toEqual([
      { text: 'Total', bbox: { x0: 100, y0: 200, x1: 300, y1: 240 }, confidence: 100 },
      { text: '12,50', bbox: { x0: 400, y0: 200, x1: 600, y1: 240 }, confidence: 100 },
      { text: 'Danke', bbox: { x0: 100, y0: 1000, x1: 400, y1: 1040 }, confidence: 50 },
    ]);
    // Weighted by characters: 10 at 100 %, 5 at 50 %
    expect(ocr.confidence).toBeCloseTo(83.33, 1);
    expect(ocr.uprightRotation).toBe(180);
    expect(ocr.imageSize).toEqual({ width: 1000, height: 2000 });
  });

  it('gives zero confidence for an empty page', () => {
    expect(toOcrResult({ text: '', imageSize: { width: 10, height: 10 }, blocks: [], rotation: 0 })).toMatchObject({
      text: '',
      words: [],
      confidence: 0,
    });
  });

  it('asks the plugin once, without calling a native "then"', async () => {
    answers.isAvailable = { available: true };
    answers.getSupportedLanguages = { languages: ['en-US', 'de-DE'] };
    answers.recognize = result;

    await expect(canRecognize(['deu'])).resolves.toBe(true);
    await expect(canRecognize(['heb'])).resolves.toBe(false);
    const ocr = await nativeOcr.recognize(new Blob(['image']), ['eng', 'deu']);

    expect(ocr.words).toHaveLength(3);
    expect(calls.map((c) => c.method)).toEqual(['isAvailable', 'getSupportedLanguages', 'recognize']);
    expect(calls[2].args[0]).toEqual({ base64: btoa('image'), languages: ['en-US', 'de-DE'] });
  });
});
