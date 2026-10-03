/*
 * Sync status for the UI, read with `useSyncStatus` (useSyncExternalStore), like auth.ts.
 *
 * - disabled: Supabase isn't configured or nobody is signed in — show nothing.
 * - locked:   signed in, but this device has no vault key (sync not set up / not unlocked).
 * - idle:     signed in and unlocked; `lastSyncedAt` says when the last run finished.
 * - syncing:  a run is in progress.
 * - offline:  no network; retried when it comes back.
 * - error:    the last run failed or skipped items; `message` says what.
 */

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'offline' | 'locked' | 'error';

export interface SyncStatus {
  state: SyncState;
  message?: string;
  /** Epoch ms of the last completed run. */
  lastSyncedAt?: number;
}

export const DISABLED_STATUS: SyncStatus = { state: 'disabled' };

let status: SyncStatus = DISABLED_STATUS;
const subscribers = new Set<() => void>();

export function getSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(listener: () => void): () => void {
  subscribers.add(listener);
  return () => subscribers.delete(listener);
}

/** Replace the status; `lastSyncedAt` carries over unless given. */
export function setSyncStatus(next: SyncStatus): void {
  const merged: SyncStatus = { lastSyncedAt: status.lastSyncedAt, ...next };
  if (merged.state === 'disabled') delete merged.lastSyncedAt;
  if (
    merged.state === status.state &&
    merged.message === status.message &&
    merged.lastSyncedAt === status.lastSyncedAt
  ) {
    return;
  }
  status = merged;
  for (const notify of subscribers) notify();
}
