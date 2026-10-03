/**
 * Opt-in re-transcription of pages with the configured cloud model. The model's text replaces
 * `ocrText`, while Tesseract's word boxes stay for the PDF text layer; a later Tesseract run
 * overwrites the page again.
 */

import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { resolveLlmConfig } from '@/lib/llm/client';
import { prepareImageForLlm } from '@/lib/llm/image';
import { transcribeWithLlm, TRANSCRIPTION_MAX_EDGE } from '@/lib/llm/transcription';
import { notifyPageOcrDone, rebuildSearchText } from '@/lib/ocr-queue';
import { requirePageImage } from '@/lib/page-image';
import type { LlmProvider, Page } from '@/types';

export type CloudOcrState = { status: 'running' } | { status: 'error'; message: string };

const RUNNING: CloudOcrState = { status: 'running' };

let states: ReadonlyMap<string, CloudOcrState> = new Map();
const subscribers = new Set<() => void>();

function setPageState(pageId: string, state: CloudOcrState | null) {
  const next = new Map(states);
  if (state) next.set(pageId, state);
  else next.delete(pageId);
  states = next;
  for (const notify of subscribers) notify();
}

/** For useSyncExternalStore: progress and errors survive closing the text sheet. */
export function subscribeCloudOcr(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

export function getCloudOcrStates(): ReadonlyMap<string, CloudOcrState> {
  return states;
}

/** The page fields written for a cloud transcription; `ocrWords` is deliberately left alone. */
export function cloudOcrPageUpdate(
  text: string,
  source: { provider: LlmProvider; model: string },
  detectedLanguage: string | undefined,
  recognizedAt = new Date()
): Pick<Page, 'ocrStatus' | 'ocrText' | 'ocrInfo'> {
  return {
    ocrStatus: 'done',
    ocrText: text,
    ocrInfo: { engine: 'llm', provider: source.provider, model: source.model, detectedLanguage, recognizedAt },
  };
}

function recognitionStamp(page: Page): number | undefined {
  return page.ocrInfo?.recognizedAt ? new Date(page.ocrInfo.recognizedAt).getTime() : undefined;
}

async function transcribePage(pageId: string): Promise<void> {
  const settings = await getSettings();
  const config = settings.llmEnabled ? resolveLlmConfig(settings) : null;
  if (!config) throw new Error('No cloud model is configured');

  const before = await db.pages.get(pageId);
  if (!before) return;
  if (before.ocrStatus === 'pending' || before.ocrStatus === 'processing') {
    throw new Error('Text recognition is still running for this page');
  }

  const image = await prepareImageForLlm(requirePageImage(before), TRANSCRIPTION_MAX_EDGE, 0.9);
  const text = await transcribeWithLlm(image, config);
  const { detectOcrLanguage } = await import('@/lib/language-detect');
  const update = cloudOcrPageUpdate(
    text,
    { provider: settings.llmProvider, model: config.model.trim() },
    detectOcrLanguage(text)
  );

  const written = await db.transaction('rw', db.pages, async () => {
    // A Tesseract run or image edit while the model was busy is newer than this result
    const current = await db.pages.get(pageId);
    if (!current || current.ocrStatus !== before.ocrStatus) return false;
    if (recognitionStamp(current) !== recognitionStamp(before)) return false;
    await db.pages.update(pageId, update);
    return true;
  });
  if (!written) return;

  await rebuildSearchText(before.documentId);
  await notifyPageOcrDone(before.documentId, before.pageNumber);
}

/** Re-transcribe pages one at a time with the cloud model. Failures are kept per page; existing text stays. */
export async function retryOcrWithLlm(pageIds: string[]): Promise<void> {
  const ids = pageIds.filter((id) => states.get(id)?.status !== 'running');
  for (const id of ids) setPageState(id, RUNNING);

  for (const id of ids) {
    try {
      await transcribePage(id);
      setPageState(id, null);
    } catch (err) {
      console.warn('Cloud text extraction failed for page', id, err);
      setPageState(id, { status: 'error', message: err instanceof Error ? err.message : 'Text extraction failed' });
    }
  }
}

export function dismissCloudOcrError(pageId: string): void {
  if (states.get(pageId)?.status === 'error') setPageState(pageId, null);
}
