/** Document summaries through the configured LLM. */

import { callLlm, LlmRefusalError, stripThinking, type LlmConfig } from './client';

export const MAX_INPUT_CHARS = 12000;
const DEFAULT_TIMEOUT_MS = 45000;
// Room for models that think before answering; the summary itself is a short paragraph
const REASONING_MAX_TOKENS = 2048;
const CHAT_MAX_TOKENS = 400;

export const SYSTEM_PROMPT =
  'You summarize scanned documents from their OCR text. Reply with only a concise summary of 2 to 4 sentences, ' +
  'in the same language as the document. Say what kind of document it is, who it is from or about, and the key ' +
  'facts such as dates, amounts, deadlines or requested actions. The OCR text may contain recognition errors; ' +
  'do not mention them. No heading, no bullet points, no markdown, no preamble.';

/**
 * Fit the pages' text into `maxChars`, sharing the budget fairly so a long first page
 * can't crowd out the rest: short pages keep all their text, long ones are cut.
 */
export function buildSummaryInput(pageTexts: string[], maxChars = MAX_INPUT_CHARS): string {
  const pages = pageTexts.map((t, i) => ({ index: i, text: t.trim() })).filter((p) => p.text);
  if (pages.length === 0) return '';

  const labelled = pages.length > 1;
  const header = (index: number) => (labelled ? `--- Page ${index + 1} ---\n` : '');
  const overhead = pages.reduce((sum, p) => sum + header(p.index).length, 0) + (pages.length - 1) * 2;
  let budget = Math.max(0, maxChars - overhead);

  // Water-filling: shortest pages first, each takes at most an equal share of what's left
  const limits = new Map<number, number>();
  const byLength = [...pages].sort((a, b) => a.text.length - b.text.length);
  byLength.forEach((p, i) => {
    const share = Math.floor(budget / (byLength.length - i));
    const take = Math.min(p.text.length, share);
    limits.set(p.index, take);
    budget -= take;
  });

  return pages
    .map((p) => {
      const limit = limits.get(p.index) ?? 0;
      let text = p.text;
      if (text.length > limit) {
        const cut = text.slice(0, Math.max(0, limit - 1));
        const space = cut.lastIndexOf(' ');
        text = `${(space > limit * 0.8 ? cut.slice(0, space) : cut).trimEnd()}…`;
      }
      return header(p.index) + text;
    })
    .join('\n\n');
}

/** Reduce a model reply to plain summary text. */
export function cleanLlmSummary(raw: string): string {
  return stripThinking(raw)
    .replace(/^\s*#+\s.*$/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*(summary|zusammenfassung|résumé|resumen|riassunto)\s*:\s*/i, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["“„«]+|["”»]+$/g, '')
    .trim();
}

export async function summarizeWithLlm(
  pageTexts: string[],
  config: LlmConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch; signal?: AbortSignal } = {}
): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, signal } = options;
  const input = buildSummaryInput(pageTexts);
  if (!input) throw new Error('This document has no recognized text to summarize');

  // Plain Chat Completions endpoints get a tight budget; reasoning-capable APIs need room to think
  const nonReasoningChat = config.schema === 'chat-completions' && !config.openaiNative;
  let raw: string;
  try {
    raw = await callLlm(
      {
        system: SYSTEM_PROMPT,
        content: input,
        maxTokens: nonReasoningChat ? CHAT_MAX_TOKENS : REASONING_MAX_TOKENS,
        timeoutMs,
      },
      config,
      { fetchImpl, signal }
    );
  } catch (err) {
    if (err instanceof LlmRefusalError) throw new Error('The model declined to summarize this document');
    throw err;
  }

  const summary = cleanLlmSummary(raw);
  if (!summary) throw new Error('The model returned an empty summary');
  return summary;
}
