/*
 * Sync status for the UI, read with `useSyncStatus` (useSyncExternalStore), like auth.ts.
 *
 * - disabled: Supabase isn't configured or nobody is signed in — show nothing.
 * - locked:   signed in, but this device has no vault key (sync not set up / not unlocked).
 * - idle:     signed in and unlocked; `lastSyncedAt` says when the last run finished.
 * - syncing:  a run is in progress.
 * - offline:  no network; retried when it comes back.
 * - error:    the last run failed or skipped items; `message` says what.
 * - paused:   another account's documents are on this device; nothing syncs until the user
 *             chooses what to do with them (`accountSwitch`, see account-switch.ts).
 */

import type { SyncErrorCode } from './errors';
import type { AccountSwitchPending } from './engine';

export type SyncState = 'disabled' | 'idle' | 'syncing' | 'offline' | 'locked' | 'error' | 'paused';

/** An item that keeps failing to upload or download; retried with backoff. */
export interface SyncProblem {
  stage: string;
  kind: string;
  id: string;
  message: string;
  code: SyncErrorCode;
  attempts: number;
  /** Epoch ms of the next automatic attempt. */
  retryAt: number;
}

export interface SyncStatus {
  state: SyncState;
  message?: string;
  /** Why the last run failed, when it did. */
  code?: SyncErrorCode;
  /** Epoch ms of the last completed run. */
  lastSyncedAt?: number;
  /** Items failing to upload or download (from the last completed run). */
  problems?: SyncProblem[];
  /** Pulled files not downloaded yet (from the last completed run). */
  pendingDownloads?: number;
  /** While paused: what's waiting for the account-switch choice. */
  accountSwitch?: AccountSwitchPending;
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

/**
 * Replace the status; `lastSyncedAt`, `problems` and `pendingDownloads` (facts from the last
 * completed run) carry over unless given.
 */
export function setSyncStatus(next: SyncStatus): void {
  const merged: SyncStatus = {
    lastSyncedAt: status.lastSyncedAt,
    problems: status.problems,
    pendingDownloads: status.pendingDownloads,
    ...next,
  };
  if (merged.state === 'disabled' || merged.state === 'locked') {
    delete merged.problems;
    delete merged.pendingDownloads;
  }
  if (merged.state === 'disabled') delete merged.lastSyncedAt;
  for (const key of Object.keys(merged) as (keyof SyncStatus)[]) if (merged[key] === undefined) delete merged[key];
  if (JSON.stringify(merged) === JSON.stringify(status)) return;
  status = merged;
  for (const notify of subscribers) notify();
}
