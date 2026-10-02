import { nanoid } from 'nanoid';
import type { AppSettings, CustomLlmEndpoint } from '@/types';

export const LEGACY_LLM_KEYS = ['llmBaseUrl', 'llmApiKey', 'llmModel'];

/** Turn the old single OpenAI-compatible endpoint setting into a custom endpoint. */
export function migrateLegacyLlmSettings(stored: Record<string, unknown>): Partial<AppSettings> | null {
  if (!LEGACY_LLM_KEYS.some((k) => k in stored)) return null;
  const baseUrl = String(stored.llmBaseUrl ?? '').trim();
  if (!baseUrl) return {};

  let name = 'Custom endpoint';
  try {
    name = new URL(baseUrl).host;
  } catch {
    // keep the generic name
  }
  const endpoint: CustomLlmEndpoint = {
    id: nanoid(),
    name,
    schema: 'chat-completions',
    baseUrl,
    apiKey: String(stored.llmApiKey ?? ''),
    model: String(stored.llmModel ?? ''),
  };
  return { llmCustomEndpoints: [endpoint], llmProvider: 'custom', llmCustomEndpointId: endpoint.id };
}
