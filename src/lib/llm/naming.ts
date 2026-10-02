/** Document naming through the configured LLM. */

import { callLlm, LlmRefusalError, stripThinking, type LlmConfig } from './client';

const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_CHARS = 80;
const DEFAULT_TIMEOUT_MS = 15000;
// Room for models that think before answering; the title itself is a few tokens
const REASONING_MAX_TOKENS = 1024;
const CHAT_MAX_TOKENS = 100;

export const SYSTEM_PROMPT =
  'You name scanned documents. Reply with only a concise, filename-style title of at most 60 characters, ' +
  'in the same language as the document. Use the pattern "<document type> – <sender or subject> – <YYYY-MM-DD>" ' +
  'and leave out any part you cannot determine. No quotes, no explanation.';

/** Reduce a model reply to a single safe title line. */
export function cleanLlmTitle(raw: string): string {
  const line =
    stripThinking(raw)
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';

  let title = line
    .replace(/[*`#]/g, '')
    .replace(/_/g, ' ')
    .replace(/^\s*(title|titel|name)\s*:\s*/i, '')
    .replace(/^["'“”„‚‘’«»]+|["'“”„‚‘’«»]+$/g, '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.pdf$/i, '')
    .replace(/\s+/g, ' ')
    .replace(/[.\s]+$/, '')
    .trim();

  if (title.length > MAX_TITLE_CHARS) {
    const cut = title.slice(0, MAX_TITLE_CHARS);
    title = cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : MAX_TITLE_CHARS).trim();
  }
  return title;
}

export async function suggestNameWithLlm(
  text: string,
  config: LlmConfig,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = options;
  // Plain Chat Completions endpoints get a tight budget; reasoning-capable APIs need room to think
  const nonReasoningChat = config.schema === 'chat-completions' && !config.openaiNative;
  let raw: string;
  try {
    raw = await callLlm(
      {
        system: SYSTEM_PROMPT,
        content: text.slice(0, MAX_INPUT_CHARS),
        maxTokens: nonReasoningChat ? CHAT_MAX_TOKENS : REASONING_MAX_TOKENS,
        timeoutMs,
      },
      config,
      { fetchImpl }
    );
  } catch (err) {
    if (err instanceof LlmRefusalError) throw new Error('The model declined to name this document');
    throw err;
  }

  const title = cleanLlmTitle(raw);
  if (!title) throw new Error('LLM returned an empty title');
  return title;
}
