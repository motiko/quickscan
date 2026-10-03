'use client';

import { useSyncExternalStore } from 'react';
import { DISABLED_STATUS, getSyncStatus, subscribeSyncStatus, type SyncStatus } from '@/lib/sync/status';

export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(subscribeSyncStatus, getSyncStatus, () => DISABLED_STATUS);
}
