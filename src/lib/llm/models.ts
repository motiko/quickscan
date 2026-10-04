/**
 * Picks a model from the provider's own model list when none is set, so the app never
 * depends on a hardcoded model ID that the provider may retire.
 */

import { joinUrl, type LlmConfig } from './client';
import { listModels } from './detect-endpoint';
import { llmFetch } from './transport';

const LIST_TIMEOUT_MS = 8000;

/** Gemini models that don't do plain text/vision generation. */
const GEMINI_EXCLUDED = /embedding|image|tts|audio|live|robotics|computer-use|aqa|nano/i;
/** OpenAI models that don't serve plain chat completions. */
const OPENAI_EXCLUDED = /audio|realtime|search|transcribe|tts|image|codex|instruct|oss|chat-latest|deep-research/i;
const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$|-\d{4}$/;
const UNSTABLE = /preview|exp/i;

function version(id: string, prefix: string): number {
  const match = id.match(new RegExp(`^${prefix}-(\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : 0;
}

/** Highest version first, then shorter (alias) IDs before longer variants. */
function newestFirst(ids: string[], prefix: string): string[] {
  return [...ids].sort((a, b) => version(b, prefix) - version(a, prefix) || a.length - b.length);
}

/** The model to use from a provider's list, or null when nothing suitable is listed. */
export function pickModel(config: Pick<LlmConfig, 'schema' | 'openaiNative'>, models: string[]): string | null {
  if (models.length === 0) return null;

  if (config.schema === 'gemini') {
    const ids = models.map((m) => m.replace(/^models\//, '')).filter((id) => id.startsWith('gemini-') && !GEMINI_EXCLUDED.test(id));
    // Google keeps this alias pointed at its current Flash model
    if (ids.includes('gemini-flash-latest')) return 'gemini-flash-latest';
    const flash = ids.filter((id) => /-flash$/.test(id));
    const stable = ids.filter((id) => !UNSTABLE.test(id) && !/lite/.test(id));
    return newestFirst(flash, 'gemini')[0] ?? newestFirst(stable, 'gemini')[0] ?? ids[0] ?? null;
  }

  if (config.openaiNative) {
    const ids = models.filter((id) => /^gpt-\d/.test(id) && !OPENAI_EXCLUDED.test(id) && !DATED_SNAPSHOT.test(id));
    const mini = ids.filter((id) => /^gpt-[\d.]+-mini$/.test(id));
    return newestFirst(mini, 'gpt')[0] ?? newestFirst(ids, 'gpt')[0] ?? null;
  }

  // Anthropic lists newest first; custom endpoints get whatever they list first
  return models[0];
}

/** OpenAI models that aren't for chat at all (speech, images, embeddings, moderation, legacy completions). */
const OPENAI_NON_CHAT = /audio|realtime|transcribe|tts|whisper|image|dall-e|sora|embedding|moderation|babbage|davinci|search-preview|deep-research|computer-use/i;

/**
 * The models worth offering in a picker: the provider's list without entries that can't do
 * plain text/vision generation, Gemini's `models/` prefix stripped (the client adds it back).
 * OpenAI's list is unordered, so it is sorted; Anthropic and custom endpoints keep their order.
 */
export function selectableModels(config: Pick<LlmConfig, 'schema' | 'openaiNative'>, models: string[]): string[] {
  let ids = [...new Set(models)];
  if (config.schema === 'gemini') {
    ids = ids.map((m) => m.replace(/^models\//, '')).filter((id) => id.startsWith('gemini-') && !GEMINI_EXCLUDED.test(id));
  } else if (config.openaiNative) {
    ids = ids.filter((id) => !OPENAI_NON_CHAT.test(id)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }
  return ids;
}

async function listGeminiModels(config: LlmConfig, fetchImpl: typeof fetch): Promise<string[] | null> {
  try {
    const response = await fetchImpl(joinUrl(config.baseUrl, 'models?pageSize=1000'), {
      headers: config.apiKey ? { 'x-goog-api-key': config.apiKey } : {},
      signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
    return (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
      .map((m) => m.name ?? '')
      .filter(Boolean);
  } catch {
    return null;
  }
}

export async function listProviderModels(config: LlmConfig, fetchImpl: typeof fetch = llmFetch): Promise<string[] | null> {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  if (config.schema === 'gemini') return listGeminiModels({ ...config, baseUrl }, fetchImpl);
  return listModels(baseUrl, config.apiKey.trim(), config.schema, fetchImpl);
}

const cache = new Map<string, Promise<string>>();

/** The configured model, or one picked from the provider's list (cached per endpoint and key). */
export function resolveModel(config: LlmConfig, fetchImpl: typeof fetch = llmFetch): Promise<string> {
  if (config.model.trim()) return Promise.resolve(config.model.trim());

  const key = [config.schema, config.baseUrl, config.apiKey].join('\n');
  let pending = cache.get(key);
  if (!pending) {
    pending = listProviderModels(config, fetchImpl).then((models) => {
      const model = models && pickModel(config, models);
      if (!model) throw new Error('Could not pick a model automatically. Enter a model ID in Settings.');
      return model;
    });
    // Don't remember failures, so a fixed key or network works on the next try
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return pending;
}

export function clearModelCache(): void {
  cache.clear();
}
