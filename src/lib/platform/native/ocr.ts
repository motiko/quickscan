import type { NativeOcrPlugin, RecognizeResult } from 'capacitor-native-ocr';
import type { OcrResult } from '@/lib/ocr';
import type { OcrProvider } from '@/lib/platform/ocr';
import type { OcrWord } from '@/types';

/*
 * OcrProvider on capacitor-native-ocr: Apple Vision in the iOS app (Android is a stub until
 * M5). Only loaded inside the app, from platform/ocr.ts. The plugin returns boxes normalized
 * to 0..1 of the image and confidences of 0..1; QuickScan stores pixels and 0–100.
 */

/**
 * Tesseract codes → BCP-47, for the languages Vision (iOS 16–18, `accurate`) or ML Kit can
 * read. Which of them this device supports comes from the plugin, in the engine's spelling:
 * `de-DE` on iOS, `de` on Android.
 */
const BCP47_BY_TESSERACT: Record<string, string> = {
  ara: 'ar-SA',
  ces: 'cs-CZ',
  chi_sim: 'zh-Hans',
  chi_tra: 'zh-Hant',
  dan: 'da-DK',
  deu: 'de-DE',
  eng: 'en-US',
  fra: 'fr-FR',
  ind: 'id-ID',
  ita: 'it-IT',
  jpn: 'ja-JP',
  kor: 'ko-KR',
  msa: 'ms-MY',
  nld: 'nl-NL',
  nor: 'no-NO',
  pol: 'pl-PL',
  por: 'pt-BR',
  ron: 'ro-RO',
  rus: 'ru-RU',
  spa: 'es-ES',
  swe: 'sv-SE',
  tha: 'th-TH',
  tur: 'tr-TR',
  ukr: 'uk-UA',
  vie: 'vi-VT',
};

// Boxed: a Capacitor plugin proxy answers every property, `then` included, so a promise
// resolving to it would call a native "then" method that never answers.
let plugin: Promise<{ native: NativeOcrPlugin }> | null = null;
let supported: Promise<string[]> | null = null;

function nativeOcrPlugin(): Promise<{ native: NativeOcrPlugin }> {
  plugin ??= import('capacitor-native-ocr').then(({ NativeOcr }) => ({ native: NativeOcr }));
  return plugin;
}

/** The engine's languages, or none when it's unavailable. Asked once per launch. */
function supportedLanguages(): Promise<string[]> {
  supported ??= (async () => {
    const { native } = await nativeOcrPlugin();
    if (!(await native.isAvailable()).available) return [];
    return (await native.getSupportedLanguages({ level: 'accurate' })).languages;
  })().catch((err: unknown) => {
    supported = null;
    throw err;
  });
  return supported;
}

/**
 * The engine's tag for `tag`: the same tag, else one for the same language (`de-DE` ↔ `de`).
 * A script is part of the language here, so `zh-Hant` never matches `zh-Hans`.
 */
function availableTag(tag: string, available: string[]): string | undefined {
  const language = (t: string) => t.split('-').filter((part, i) => i === 0 || part.length === 4).join('-');
  return available.find((a) => a === tag) ?? available.find((a) => language(a) === language(tag));
}

/** The engine's tags for these Tesseract codes, or undefined if any of them can't be read natively. */
export function toNativeLanguages(langs: string[], available: string[]): string[] | undefined {
  const tags: string[] = [];
  for (const code of langs) {
    const tag = BCP47_BY_TESSERACT[code] && availableTag(BCP47_BY_TESSERACT[code], available);
    if (!tag) return undefined;
    tags.push(tag);
  }
  return tags;
}

/** Whether the native engine is available and reads every one of `langs`. */
export async function canRecognize(langs: string[]): Promise<boolean> {
  return toNativeLanguages(langs, await supportedLanguages()) !== undefined;
}

/** The plugin's result as Tesseract's: pixel boxes, 0–100 confidence weighted by line length. */
export function toOcrResult(result: RecognizeResult): OcrResult {
  const { width, height } = result.imageSize;
  const words: OcrWord[] = [];
  let weighted = 0;
  let chars = 0;
  for (const block of result.blocks) {
    for (const line of block.lines) {
      const length = line.text.replace(/\s/g, '').length;
      weighted += (line.confidence ?? 0) * length;
      chars += length;
      for (const word of line.words) {
        const text = word.text.trim();
        if (!text) continue;
        const { x, y, width: w, height: h } = word.box;
        words.push({
          text,
          bbox: {
            x0: Math.round(x * width),
            y0: Math.round(y * height),
            x1: Math.round((x + w) * width),
            y1: Math.round((y + h) * height),
          },
          confidence: Math.round((word.confidence ?? 0) * 100),
        });
      }
    }
  }
  return {
    text: result.text.trim(),
    words,
    confidence: chars ? (weighted / chars) * 100 : 0,
    uprightRotation: result.rotation,
    imageSize: result.imageSize,
  };
}

async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // In chunks: String.fromCharCode with a whole image's bytes as arguments overflows the stack
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export const nativeOcr: OcrProvider = {
  engine: 'vision',
  async recognize(image, langs) {
    const languages = toNativeLanguages(langs, await supportedLanguages());
    if (!languages) throw new Error(`Native OCR can't read ${langs.join('+')}`);
    const { native } = await nativeOcrPlugin();
    return toOcrResult(await native.recognize({ base64: await toBase64(image), languages }));
  },
};
