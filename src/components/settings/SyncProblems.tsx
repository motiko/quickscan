'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { useAuth } from '@/hooks/useAuth';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { confirmDialog } from '@/lib/dialogs';
import { retrySync, type SyncProblem } from '@/lib/sync';
import { badRowsKey, cleanupKey, type BadRow, type CleanupState } from '@/lib/sync/state';
import { forgetVault } from '@/lib/vault-session';

const hintClass = 'text-xs text-gray-500 dark:text-gray-400';
const errorClass = 'text-xs text-red-600 dark:text-red-400';
const linkButtonClass = 'min-h-11 text-sm font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-50';
const MAX_LISTED = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const KIND_LABEL: Record<string, string> = {
  document: 'Document',
  page: 'Page image',
  folder: 'Folder',
  signature: 'Signature',
  settings: 'Setting',
};

function describeProblem(p: SyncProblem): string {
  const what = KIND_LABEL[p.kind] ?? 'Item';
  const action = p.stage === 'download' ? 'couldn’t download' : 'couldn’t upload';
  const hint =
    p.code === 'quota'
      ? 'storage full or file too large'
      : p.code === 'auth'
        ? 'sign-in expired'
        : p.code === 'offline'
          ? 'no connection'
          : p.message;
  const when = new Date(p.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return `${what} ${action} (${hint}). Next try ${when}.`;
}

/**
 * Sync problems under the status line: the last error with what to do about it, items that
 * keep failing (retried with backoff), rows that couldn't be read, files still to download,
 * and storage use. Renders only what applies.
 */
export function SyncProblems() {
  const auth = useAuth();
  const status = useSyncStatus();
  const userId = auth.status === 'signed-in' ? auth.user.id : null;
  const badRows = useLiveQuery(
    async () => (userId ? ((await db.syncMeta.get(badRowsKey(userId)))?.value as BadRow[] | undefined) : undefined),
    [userId]
  );
  const cleanup = useLiveQuery(
    async () => (userId ? ((await db.syncMeta.get(cleanupKey(userId)))?.value as CleanupState | undefined) : undefined),
    [userId]
  );

  const problems = status.problems ?? [];
  const unreadable = badRows?.length ?? 0;
  const pending = status.pendingDownloads ?? 0;
  const failed = status.state === 'error' || status.state === 'offline';
  const showRetry = failed || problems.length > 0 || unreadable > 0;
  const usage = cleanup?.usage;

  const unlockAgain = async () => {
    const confirmed = await confirmDialog({
      title: 'Unlock sync again?',
      message:
        'This device stops syncing until you unlock it with your recovery key or a code from another device. Your documents stay on this device.',
      confirmLabel: 'Unlock again',
    });
    if (confirmed) await forgetVault();
  };

  if (!showRetry && pending === 0 && !usage) return null;

  return (
    <div className="mt-1 space-y-1" aria-live="polite">
      {status.code === 'key-mismatch' && (
        <button onClick={() => void unlockAgain()} className={linkButtonClass}>
          Unlock with recovery key
        </button>
      )}
      {problems.length > 0 && (
        <ul className="space-y-1">
          {problems.slice(0, MAX_LISTED).map((p) => (
            <li key={`${p.stage}:${p.kind}:${p.id}`} className={errorClass}>
              {describeProblem(p)}
            </li>
          ))}
          {problems.length > MAX_LISTED && <li className={errorClass}>…and {problems.length - MAX_LISTED} more.</li>}
        </ul>
      )}
      {unreadable > 0 && (
        <p className={errorClass}>
          {plural(unreadable, 'item')} from your account couldn’t be read: damaged, encrypted with another key, or from a
          newer version of QuickScan.
        </p>
      )}
      {pending > 0 && <p className={hintClass}>{plural(pending, 'file')} not downloaded yet.</p>}
      {usage && (
        <p className={hintClass}>
          Using {formatBytes(usage.bytes)} in {plural(usage.files, 'file')} (as of{' '}
          {new Date(usage.at).toLocaleDateString()}).
        </p>
      )}
      {showRetry && (
        <button onClick={() => void retrySync()} disabled={status.state === 'syncing'} className={linkButtonClass}>
          Retry now
        </button>
      )}
    </div>
  );
}
