'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { getSettings, DEFAULT_SETTINGS } from '@/lib/settings';

export function useSettings() {
  const settings = useLiveQuery(() => getSettings(), []);
  return { settings: settings ?? DEFAULT_SETTINGS, isLoading: settings === undefined };
}
