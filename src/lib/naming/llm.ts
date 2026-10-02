/**
 * Document naming through a hosted or custom LLM, called directly from the browser.
 * Supports OpenAI, Anthropic and Google natively, plus custom endpoints speaking either
 * OpenAI Chat Completions (OpenRouter, Ollama, LM Studio, ...) or Anthropic Messages.
 * Providers that don't send CORS headers go through the same-origin /api/llm proxy.
 */

import type { AppSettings, LlmApiSchema } from '@/types';

export interface LlmConfig {
  schema: LlmApiSchema | 'gemini';
  baseUrl: string;
  apiKey: string;
  model: string;
  /** OpenAI's own API: its reasoning models reject `max_tokens` and `temperature`. */
  openaiNative?: boolean;
}

export const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

const MAX_INPUT_CHARS = 4000;
const MAX_TITLE_CHARS = 80;
const DEFAULT_TIMEOUT_MS = 15000;
// Room for models that think before answering; the title itself is a few tokens
const REASONING_MAX_TOKENS = 1024;

const SYSTEM_PROMPT =
  'You name scanned documents. Reply with only a concise, filename-style title of at most 60 characters, ' +
  'in the same language as the document. Use the pattern "<document type> – <sender or subject> – <YYYY-MM-DD>" ' +
  'and leave out any part you cannot determine. No quotes, no explanation.';

/** Hosts whose API rejects browser preflights; only these may be reached through the proxy. */
export const PROXIED_HOSTS = ['ollama.com'];
export const PROXY_PATH = '/api/llm';
export const PROXY_TARGET_HEADER = 'X-LLM-Target';

/** The configuration of the provider selected in settings, or null when it is incomplete. */
export function resolveLlmConfig(settings: AppSettings): LlmConfig | null {
  let config: LlmConfig | null = null;
  switch (settings.llmProvider) {
    case 'openai':
      config = {
        schema: 'chat-completions',
        baseUrl: PROVIDER_BASE_URLS.openai,
        apiKey: settings.openaiApiKey,
        model: settings.openaiModel,
        openaiNative: true,
      };
      break;
    case 'anthropic':
      config = {
        schema: 'anthropic-messages',
        baseUrl: PROVIDER_BASE_URLS.anthropic,
        apiKey: settings.anthropicApiKey,
        model: settings.anthropicModel,
      };
      break;
    case 'google':
      config = {
        schema: 'gemini',
        baseUrl: PROVIDER_BASE_URLS.google,
        apiKey: settings.googleApiKey,
        model: settings.googleModel,
      };
      break;
    case 'custom': {
      const endpoint = settings.llmCustomEndpoint;
      config = { schema: endpoint.schema, baseUrl: endpoint.baseUrl, apiKey: endpoint.apiKey, model: endpoint.model };
      break;
    }
  }
  if (!config || !config.baseUrl.trim() || !config.model.trim()) return null;
  // Hosted providers always need a key; custom endpoints (e.g. local Ollama) may not
  if (settings.llmProvider !== 'custom' && !config.apiKey.trim()) return null;
  return config;
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${path}`;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return joinUrl(baseUrl, 'chat/completions');
}

export function isProxiedUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && PROXIED_HOSTS.includes(hostname);
  } catch {
    return false;
  }
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

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  readText: (data: unknown) => string;
}

function buildRequest(text: string, config: LlmConfig): ProviderRequest {
  const input = text.slice(0, MAX_INPUT_CHARS);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };

  switch (config.schema) {
    case 'anthropic-messages':
      if (config.apiKey) headers['x-api-key'] = config.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      headers['anthropic-dangerous-direct-browser-access'] = 'true';
      return {
        url: joinUrl(config.baseUrl, 'messages'),
        headers,
        body: {
          model: config.model,
          max_tokens: REASONING_MAX_TOKENS,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: input }],
        },
        readText: (data) => {
          const reply = data as { stop_reason?: string; content?: { type: string; text?: string }[] };
          if (reply.stop_reason === 'refusal') throw new Error('The model declined to name this document');
          return (reply.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');
        },
      };

    case 'gemini': {
      if (config.apiKey) headers['x-goog-api-key'] = config.apiKey;
      const model = config.model.trim().replace(/^models\//, '');
      return {
        url: joinUrl(config.baseUrl, `models/${encodeURIComponent(model)}:generateContent`),
        headers,
        body: {
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
          contents: [{ role: 'user', parts: [{ text: input }] }],
          generationConfig: { maxOutputTokens: REASONING_MAX_TOKENS },
        },
        readText: (data) => {
          const reply = data as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
          return (reply.candidates?.[0]?.content?.parts ?? [])
            .filter((p) => !p.thought)
            .map((p) => p.text ?? '')
            .join('');
        },
      };
    }

    case 'chat-completions':
      if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
      return {
        url: chatCompletionsUrl(config.baseUrl),
        headers,
        body: {
          model: config.model,
          ...(config.openaiNative
            ? { max_completion_tokens: REASONING_MAX_TOKENS }
            : { temperature: 0.2, max_tokens: 100 }),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: input },
          ],
        },
        readText: (data) =>
          (data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '',
      };
  }
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
    const request = buildRequest(text, config);
    // The proxy only forwards chat completions requests to allowlisted hosts
    const viaProxy = config.schema === 'chat-completions' && isProxiedUrl(request.url);
    if (viaProxy) request.headers[PROXY_TARGET_HEADER] = request.url;

    const response = await fetchImpl(viaProxy ? PROXY_PATH : request.url, {
      method: 'POST',
      headers: request.headers,
      signal: controller.signal,
      body: JSON.stringify(request.body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    const title = cleanLlmTitle(request.readText(await response.json()));
    if (!title) throw new Error('LLM returned an empty title');
    return title;
  } finally {
    clearTimeout(timer);
  }
}
