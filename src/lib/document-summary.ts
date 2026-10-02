import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { collectDocumentText } from '@/lib/ocr-text';
import { resolveLlmConfig } from '@/lib/llm/client';
import { summarizeWithLlm } from '@/lib/llm/summary';
import type { DocumentSummary, Page } from '@/types';

type TextPage = Pick<Page, 'ocrStatus' | 'ocrText'>;

/** Short, stable fingerprint of a string (32-bit FNV-1a, hex). Not cryptographic. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Fingerprint of the recognized text a summary is written from. */
export function summarySourceHash(pages: TextPage[]): string {
  return hashText(collectDocumentText(pages));
}

/** True when the pages' text has changed since the summary was written. */
export function isSummaryOutdated(summary: Pick<DocumentSummary, 'sourceHash'>, pages: TextPage[]): boolean {
  return summary.sourceHash !== summarySourceHash(pages);
}

/** Summarize a document's recognized text with the configured LLM and store the result. */
export async function generateDocumentSummary(documentId: string): Promise<DocumentSummary> {
  const settings = await getSettings();
  const config = settings.llmEnabled ? resolveLlmConfig(settings) : null;
  if (!config) throw new Error('No language model is configured');

  const pages = await db.pages.where('documentId').equals(documentId).sortBy('pageNumber');
  const pageTexts = pages.map((p) => (p.ocrStatus === 'done' ? p.ocrText ?? '' : ''));
  const text = await summarizeWithLlm(pageTexts, config);

  const summary: DocumentSummary = {
    text,
    model: config.model,
    createdAt: new Date(),
    sourceHash: summarySourceHash(pages),
  };
  // The document may have been deleted while the model was answering
  await db.documents.update(documentId, { summary });
  return summary;
}
