import { db } from '@/lib/db';
import type { AppSettings } from '@/types';

export const DEFAULT_SETTINGS: AppSettings = {
  ocrEnabled: true,
  ocrLanguages: ['eng'],
  llmEnabled: false,
  llmProvider: 'openai',
  openaiApiKey: '',
  openaiModel: 'gpt-5-mini',
  anthropicApiKey: '',
  anthropicModel: 'claude-opus-5-5',
  googleApiKey: '',
  googleModel: 'gemini-2.5-flash',
  llmCustomEndpoint: { baseUrl: '', apiKey: '', model: '', schema: 'chat-completions' },
};

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
