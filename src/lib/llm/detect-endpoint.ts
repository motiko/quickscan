/**
 * Works out which API a custom endpoint speaks by listing its models, so the user only
 * has to enter a URL (and maybe a key). Also tolerates URLs missing their '/v1' suffix.
 */

import type { LlmApiSchema } from '@/types';
import { PROXY_PATH, PROXY_TARGET_HEADER, isProxiedUrl } from './client';

export interface DetectedEndpoint {
  /** The base URL that answered, which may differ from the one entered. */
  baseUrl: string;
  schema: LlmApiSchema;
  models: string[];
}

const DETECT_TIMEOUT_MS = 8000;

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** The URL as entered, then with '/v1' appended, then the origin with '/v1'. */
export function candidateBaseUrls(baseUrl: string): string[] {
  const base = trimUrl(baseUrl);
  const candidates = [base];
  if (!/\/v\d+$/.test(base)) candidates.push(`${base}/v1`);
  try {
    candidates.push(`${new URL(base).origin}/v1`);
  } catch {
    return [];
  }
  return [...new Set(candidates)];
}

/** Best guess when the endpoint can't list its models. */
export function guessSchema(baseUrl: string): LlmApiSchema {
  return /anthropic/i.test(baseUrl) ? 'anthropic-messages' : 'chat-completions';
}

/** Model IDs listed at `${baseUrl}/models`, or null when it doesn't answer in the given schema. */
export async function listModels(
  baseUrl: string,
  apiKey: string,
  schema: LlmApiSchema,
  fetchImpl: typeof fetch
): Promise<string[] | null> {
  const url = `${baseUrl}/models`;
  const headers: Record<string, string> = {};
  if (schema === 'anthropic-messages') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  // The proxy only forwards Bearer-authenticated requests
  const viaProxy = schema === 'chat-completions' && isProxiedUrl(url);
  if (viaProxy) headers[PROXY_TARGET_HEADER] = url;

  try {
    const response = await fetchImpl(viaProxy ? PROXY_PATH : url, {
      headers,
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { id?: string; type?: string }[]; has_more?: boolean };
    if (!Array.isArray(body.data)) return null;
    // Anthropic's list has `has_more` and entries of type 'model'; OpenAI-style lists have neither
    const looksAnthropic = 'has_more' in body || body.data[0]?.type === 'model';
    if (looksAnthropic !== (schema === 'anthropic-messages')) return null;
    return body.data.map((m) => m.id ?? '').filter(Boolean);
  } catch {
    return null;
  }
}

/** The endpoint's API schema and models, or null when no candidate URL lists models. */
export async function detectEndpoint(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<DetectedEndpoint | null> {
  const key = apiKey.trim();
  const schemas: LlmApiSchema[] =
    guessSchema(baseUrl) === 'anthropic-messages'
      ? ['anthropic-messages', 'chat-completions']
      : ['chat-completions', 'anthropic-messages'];

  for (const candidate of candidateBaseUrls(baseUrl)) {
    for (const schema of schemas) {
      const models = await listModels(candidate, key, schema, fetchImpl);
      if (models) return { baseUrl: candidate, schema, models };
    }
  }
  return null;
}
