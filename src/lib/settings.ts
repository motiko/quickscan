import { db } from '@/lib/db';
import type { AppSettings, CustomLlmEndpoint } from '@/types';

export const DEFAULT_SETTINGS: AppSettings = {
  ocrEnabled: true,
  ocrLanguages: ['eng'],
  autoName: true,
  llmEnabled: false,
  llmProvider: 'openai',
  llmCustomEndpointId: '',
  openaiApiKey: '',
  openaiModel: 'gpt-5-mini',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-5-5',
  googleApiKey: '',
  googleModel: 'gemini-2.5-flash',
  llmCustomEndpoints: [],
};

/** Starting points for a new custom endpoint. */
export const CUSTOM_ENDPOINT_PRESETS: Omit<CustomLlmEndpoint, 'id' | 'apiKey' | 'model'>[] = [
  { name: 'OpenRouter', schema: 'chat-completions', baseUrl: 'https://openrouter.ai/api/v1' },
  { name: 'Ollama Cloud', schema: 'chat-completions', baseUrl: 'https://ollama.com/v1' },
  { name: 'Ollama (local)', schema: 'chat-completions', baseUrl: 'http://localhost:11434/v1' },
  { name: 'LM Studio', schema: 'chat-completions', baseUrl: 'http://localhost:1234/v1' },
];

export async function getSettings(): Promise<AppSettings> {
  const rows = await db.settings.toArray();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { ...DEFAULT_SETTINGS, ...stored } as AppSettings;
}

export async function updateSettings(updates: Partial<AppSettings>): Promise<void> {
  await db.settings.bulkPut(
    Object.entries(updates).map(([key, value]) => ({ key, value }))
  );
}
