import type { Worker as TesseractWorker, Page as TesseractPage } from 'tesseract.js';
import type { OcrWord } from '@/types';

export interface OcrResult {
  text: string;
  words: OcrWord[];
  confidence: number;
}

let worker: TesseractWorker | null = null;
let workerLangs = '';
let workerPromise: Promise<TesseractWorker> | null = null;

async function getWorker(langs: string[]): Promise<TesseractWorker> {
  const key = langs.join('+');
  if (workerPromise && workerLangs === key) return workerPromise;

  workerLangs = key;
  workerPromise = (async () => {
    const { createWorker } = await import('tesseract.js');
    if (worker) {
      await worker.reinitialize(key);
      return worker;
    }
    worker = await createWorker(key);
    return worker;
  })();

  try {
    return await workerPromise;
  } catch (err) {
    // Allow a retry on the next call (e.g. language data failed to download offline)
    workerPromise = null;
    workerLangs = '';
    throw err;
  }
}

export function extractWords(page: TesseractPage): OcrWord[] {
  const words: OcrWord[] = [];
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          const text = word.text.trim();
          if (!text) continue;
          words.push({ text, bbox: { ...word.bbox }, confidence: word.confidence });
        }
      }
    }
  }
  return words;
}

export async function recognize(image: Blob, langs: string[]): Promise<OcrResult> {
  const w = await getWorker(langs.length > 0 ? langs : ['eng']);
  const { data } = await w.recognize(image, {}, { text: true, blocks: true });
  return {
    text: data.text.trim(),
    words: extractWords(data),
    confidence: data.confidence,
  };
}

export async function terminateOcr(): Promise<void> {
  const w = worker;
  worker = null;
  workerPromise = null;
  workerLangs = '';
  if (w) await w.terminate();
}
