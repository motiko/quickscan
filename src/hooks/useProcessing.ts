'use client';

import { useSyncExternalStore } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { getImportState, subscribeImport, type ImportState } from '@/lib/import';
import { useSettings } from '@/hooks/useSettings';

const SERVER_STATE: ImportState = { total: 0, done: 0, failures: [], active: false };

export function useImportState(): ImportState {
  return useSyncExternalStore(subscribeImport, getImportState, () => SERVER_STATE);
}

/**
 * Pages still waiting for or undergoing OCR, grouped by document.
 * Empty while OCR is switched off, since nothing would ever finish.
 */
export function useOcrProgress(): { pendingPages: number; documentIds: Set<string> } {
  const { settings } = useSettings();
  const pages = useLiveQuery(
    () => db.pages.where('ocrStatus').anyOf('pending', 'processing').toArray(),
    []
  );

  if (!settings.ocrEnabled || !pages) return { pendingPages: 0, documentIds: new Set() };
  return { pendingPages: pages.length, documentIds: new Set(pages.map((p) => p.documentId)) };
}
