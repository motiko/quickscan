'use client';

import { useEffect } from 'react';
import { startSyncScheduler } from '@/lib/sync';

/** Runs cloud sync in the background; does nothing unless Supabase is configured. */
export function SyncRunner() {
  useEffect(() => startSyncScheduler(), []);
  return null;
}
