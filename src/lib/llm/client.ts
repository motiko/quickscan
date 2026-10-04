/**
 * Shared LLM client, called directly from the browser for naming, text extraction and summaries.
 * Supports OpenAI, Anthropic and Google natively, plus custom endpoints speaking either
 * OpenAI Chat Completions (OpenRouter, Ollama, LM Studio, ...) or Anthropic Messages.
 * Providers that don't send CORS headers go through the same-origin /api/llm proxy.
 */

import type { AppSettings, LlmApiSchema } from '@/types';
import { resolveModel } from './models';
import { llmFetch } from './transport';
import { isNativeApp } from '@/lib/native-passkey';

export interface LlmConfig {
  schema: LlmApiSchema | 'gemini';
  baseUrl: string;
  apiKey: string;
  /** Empty means pick one from the provider's model list at call time. */
  model: string;
  /** OpenAI's own API: its reasoning models reject `max_tokens` and `temperature`. */
  openaiNative?: boolean;
}

export type LlmImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp';

export type LlmContentPart =
  | { type: 'text'; text: string }
  /** `data` is base64 without a `data:` prefix. */
  | { type: 'image'; mediaType: LlmImageMediaType; data: string };

export interface LlmRequest {
  system: string;
  content: string | LlmContentPart[];
  maxTokens: number;
  timeoutMs: number;
  /** Defaults to 0.2 for Chat Completions endpoints; never sent to OpenAI itself. */
  temperature?: number;
}

export interface LlmCallOptions {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/** Thrown when the model explicitly refuses to answer. */
export class LlmRefusalError extends Error {
  constructor() {
    super('The model declined the request');
    this.name = 'LlmRefusalError';
  }
}

export const PROVIDER_BASE_URLS = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
} as const;

const DEFAULT_TEMPERATURE = 0.2;

/** Hosts whose API rejects browser preflights; only these may be reached through the proxy. */
export const PROXIED_HOSTS = ['ollama.com'];
export const PROXY_PATH = '/api/llm';
export const PROXY_TARGET_HEADER = 'X-LLM-Target';

/** The configuration of the provider selected in settings, or null when it is incomplete. The model may be empty. */
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
  if (!config || !config.baseUrl.trim()) return null;
  // Hosted providers always need a key; custom endpoints (e.g. local Ollama) may not
  if (settings.llmProvider !== 'custom' && !config.apiKey.trim()) return null;
  return config;
}

export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/${path}`;
}

export function chatCompletionsUrl(baseUrl: string): string {
  return joinUrl(baseUrl, 'chat/completions');
}

/**
 * Whether a request to `url` goes through /api/llm: on the web only, for chat-completions
 * endpoints on PROXIED_HOSTS. The app has no /api/llm and needs none: it calls every endpoint
 * over native HTTP (`llmFetch`), where CORS doesn't apply.
 */
export function viaLlmProxy(url: string, schema: LlmConfig['schema']): boolean {
  return !isNativeApp() && schema === 'chat-completions' && isProxiedUrl(url);
}

/**
 * Whether requests to `url` cross the internet unencrypted: plain http:// to a host that isn't
 * this device or on the local network (private IPv4 ranges, Tailscale's 100.64/10, IPv6 ULA
 * and link-local, `.local`, single-label names). The app reaches such endpoints (native HTTP
 * allows cleartext for self-hosted servers), but the API key and the documents travel in clear.
 */
export function isCleartextOverInternet(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || !host.includes('.') && !host.includes(':')) return false;
  const v4 = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    const local =
      a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
    return !local;
  }
  if (host.includes(':')) return !(host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host));
  return true;
}

export function isProxiedUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'https:' && PROXIED_HOSTS.includes(hostname);
  } catch {
    return false;
  }
}

/** Remove `<think>` blocks that some models put inline in their reply. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, '');
}

interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  readText: (data: unknown) => string;
}

function chatCompletionsContent(content: string | LlmContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
  );
}

function anthropicContent(content: string | LlmContentPart[]) {
  if (typeof content === 'string') return content;
  return content.map((part) =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
  );
}

function geminiParts(content: string | LlmContentPart[]) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map((part) =>
    part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: part.data } }
  );
}

export function buildRequest(request: LlmRequest, config: LlmConfig): ProviderRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const { system, content, maxTokens, temperature } = request;

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
          max_tokens: maxTokens,
          ...(temperature !== undefined && { temperature }),
          system,
          messages: [{ role: 'user', content: anthropicContent(content) }],
        },
        readText: (data) => {
          const reply = data as { stop_reason?: string; content?: { type: string; text?: string }[] };
          if (reply.stop_reason === 'refusal') throw new LlmRefusalError();
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
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: geminiParts(content) }],
          generationConfig: { maxOutputTokens: maxTokens, ...(temperature !== undefined && { temperature }) },
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
            ? { max_completion_tokens: maxTokens }
            : { temperature: temperature ?? DEFAULT_TEMPERATURE, max_tokens: maxTokens }),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: chatCompletionsContent(content) },
          ],
        },
        readText: (data) =>
          (data as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content ?? '',
      };
  }
}

/** Send a single-turn request and return the model's reply text, without thinking parts the API marks as such. */
export async function callLlm(request: LlmRequest, config: LlmConfig, options: LlmCallOptions = {}): Promise<string> {
  const { fetchImpl = llmFetch, signal } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const model = await resolveModel(config, fetchImpl);
    const built = buildRequest(request, { ...config, model });
    // The proxy only forwards chat completions requests to allowlisted hosts
    const viaProxy = viaLlmProxy(built.url, config.schema);
    if (viaProxy) built.headers[PROXY_TARGET_HEADER] = built.url;

    const response = await fetchImpl(viaProxy ? PROXY_PATH : built.url, {
      method: 'POST',
      headers: built.headers,
      signal: controller.signal,
      body: JSON.stringify(built.body),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`LLM request failed (${response.status}): ${detail.slice(0, 200)}`);
    }

    return built.readText(await response.json());
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
