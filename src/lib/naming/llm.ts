/**
 * Document naming through any OpenAI-compatible chat completions endpoint
 * (OpenRouter, Ollama, LM Studio, ...). Called directly from the browser.
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_CHARS = 80;
const DEFAULT_TIMEOUT_MS = 15000;

const SYSTEM_PROMPT =
  'You name scanned documents. Reply with only a concise, filename-style title of at most 60 characters, ' +
  'in the same language as the document. Use the pattern "<document type> – <sender or subject> – <YYYY-MM-DD>" ' +
  'and leave out any part you cannot determine. No quotes, no explanation.';

export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
}

/** Reduce a model reply to a single safe title line. */
export function cleanLlmTitle(raw: string): string {
  const withoutThinking = raw.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
  const line =
    withoutThinking
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
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

    const response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        max_tokens: 100,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text.slice(0, MAX_INPUT_CHARS) },
        ],
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const title = cleanLlmTitle(data.choices?.[0]?.message?.content ?? '');
    if (!title) throw new Error('LLM returned an empty title');
    return title;
  } finally {
    clearTimeout(timer);
  }
}
