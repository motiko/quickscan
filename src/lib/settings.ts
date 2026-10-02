import { db } from '@/lib/db';
import type { AppSettings } from '@/types';

export const DEFAULT_SETTINGS: AppSettings = {
  ocrEnabled: true,
  ocrLanguages: ['eng'],
  autoName: true,
  llmEnabled: false,
  llmBaseUrl: '',
  llmApiKey: '',
  llmModel: '',
};

export const LLM_PRESETS: { label: string; baseUrl: string }[] = [
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  { label: 'Ollama Cloud', baseUrl: 'https://ollama.com/v1' },
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1' },
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
