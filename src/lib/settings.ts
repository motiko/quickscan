import { db } from '@/lib/db';
import type { AppSettings } from '@/types';

export const DEFAULT_SETTINGS: AppSettings = {
  ocrEnabled: true,
  ocrLanguages: ['eng'],
};

export const OCR_LANGUAGES: { code: string; label: string }[] = [
  { code: 'eng', label: 'English' },
  { code: 'deu', label: 'German' },
  { code: 'fra', label: 'French' },
  { code: 'spa', label: 'Spanish' },
  { code: 'ita', label: 'Italian' },
  { code: 'nld', label: 'Dutch' },
  { code: 'por', label: 'Portuguese' },
  { code: 'pol', label: 'Polish' },
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
