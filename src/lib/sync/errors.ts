import { SyncBackendError } from './backend';
import { SyncError } from './engine';

/*
 * What went wrong, in terms the user can act on. `classifySyncError` maps a failed run or a
 * failed item to one of these; `SYNC_ERROR_TEXT` says what to do about it.
 */

export type SyncErrorCode = 'offline' | 'key-mismatch' | 'quota' | 'auth' | 'unknown';

export const SYNC_ERROR_TEXT: Record<SyncErrorCode, string> = {
  offline: 'Can’t reach the server. Changes sync when you’re back online.',
  'key-mismatch':
    'This device’s encryption key doesn’t match your account. Unlock sync again with your recovery key.',
  quota: 'The server refused a file: your storage may be full, or a file is larger than 20 MB.',
  auth: 'Your sign-in has expired. Sign out and sign in again to keep syncing.',
  unknown: 'Sync failed. Retrying soon.',
};

const AUTH_PATTERN = /jwt expired|invalid jwt|jwt.*(malformed|invalid)|not signed in|refresh token|invalid claim|unauthorized/i;
const QUOTA_PATTERN = /payload too large|entity too large|exceeded|quota|maximum allowed size|too large/i;

export function classifySyncError(err: unknown): SyncErrorCode {
  if (err instanceof SyncError && err.code === 'key-mismatch') return 'key-mismatch';
  if (err instanceof SyncBackendError) {
    if (err.network) return 'offline';
    if (err.status === 401) return 'auth';
    if (err.status === 413) return 'quota';
  }
  return classifyMessage(err instanceof Error ? err.message : String(err));
}

/** For per-item problems, which carry only a message. */
export function classifyMessage(message: string): SyncErrorCode {
  if (AUTH_PATTERN.test(message)) return 'auth';
  if (QUOTA_PATTERN.test(message)) return 'quota';
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message)) return 'offline';
  return 'unknown';
}
