import type { AppSettings, CustomLlmEndpoint, LlmApiSchema } from '@/types';

/** The single OpenAI-compatible endpoint from before multiple providers. */
const LEGACY_ENDPOINT_KEYS = ['llmBaseUrl', 'llmApiKey', 'llmModel'];
/** The list of named custom endpoints, now a single custom endpoint. */
const ENDPOINT_LIST_KEYS = ['llmCustomEndpoints', 'llmCustomEndpointId'];
export const LEGACY_LLM_KEYS = [...LEGACY_ENDPOINT_KEYS, ...ENDPOINT_LIST_KEYS];

interface ListedEndpoint {
  id: string;
  schema: LlmApiSchema;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Turn older custom endpoint settings into the single custom endpoint. */
export function migrateLegacyLlmSettings(stored: Record<string, unknown>): Partial<AppSettings> | null {
  if (!LEGACY_LLM_KEYS.some((k) => k in stored)) return null;

  const list = Array.isArray(stored.llmCustomEndpoints) ? (stored.llmCustomEndpoints as ListedEndpoint[]) : [];
  if (list.length > 0) {
    const selected = list.find((e) => e.id === stored.llmCustomEndpointId) ?? list[0];
    const endpoint: CustomLlmEndpoint = {
      baseUrl: selected.baseUrl,
      apiKey: selected.apiKey,
      model: selected.model,
      schema: selected.schema,
    };
    return { llmCustomEndpoint: endpoint };
  }

  const baseUrl = String(stored.llmBaseUrl ?? '').trim();
  if (!baseUrl) return {};
  const endpoint: CustomLlmEndpoint = {
    baseUrl,
    apiKey: String(stored.llmApiKey ?? ''),
    model: String(stored.llmModel ?? ''),
    schema: 'chat-completions',
  };
  return { llmCustomEndpoint: endpoint, llmProvider: 'custom' };
}
