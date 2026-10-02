import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { suggestName } from './heuristic';
import { resolveLlmConfig } from '@/lib/llm/client';
import { suggestNameWithLlm } from '@/lib/llm/naming';

export interface NameSuggestion {
  name: string;
  source: 'llm' | 'heuristic';
}

async function getDocumentText(documentId: string): Promise<string> {
  const pages = await db.pages.where('documentId').equals(documentId).sortBy('pageNumber');
  return pages
    .map((p) => (p.ocrStatus === 'done' ? p.ocrText ?? '' : ''))
    .filter(Boolean)
    .join('\n\n');
}

/** Suggest a name from the document's recognized text; the LLM is used when configured, else heuristics. */
export async function suggestDocumentName(documentId: string): Promise<NameSuggestion | null> {
  const doc = await db.documents.get(documentId);
  if (!doc) return null;
  const text = await getDocumentText(documentId);
  if (!text.trim()) return null;

  const settings = await getSettings();
  const llmConfig = settings.llmEnabled ? resolveLlmConfig(settings) : null;
  if (llmConfig) {
    try {
      const name = await suggestNameWithLlm(text, llmConfig);
      return { name, source: 'llm' };
    } catch (err) {
      console.warn('LLM naming failed, falling back to heuristics:', err);
    }
  }

  const name = suggestName(text, new Date(doc.createdAt));
  return name ? { name, source: 'heuristic' } : null;
}

/**
 * Rename a document that still has its generated "Scan …" name once all of its pages
 * have been recognized. Never touches names the user chose.
 */
export async function autoNameIfDefault(documentId: string): Promise<void> {
  const doc = await db.documents.get(documentId);
  if (doc?.nameSource !== 'default') return;

  const unfinished = await db.pages
    .where('documentId')
    .equals(documentId)
    .filter((p) => p.ocrStatus === 'pending' || p.ocrStatus === 'processing')
    .count();
  if (unfinished > 0) return;

  const suggestion = await suggestDocumentName(documentId);
  if (!suggestion) return;

  await db.transaction('rw', db.documents, async () => {
    // The user may have renamed it while the suggestion was being computed
    const current = await db.documents.get(documentId);
    if (current?.nameSource !== 'default') return;
    await db.documents.update(documentId, { name: suggestion.name, nameSource: 'auto' });
  });
}
