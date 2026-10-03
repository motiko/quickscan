'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSyncStatus } from '@/hooks/useSyncStatus';
import { requestSync } from '@/lib/sync';
import type { SyncStatus } from '@/lib/sync/status';

function relativeTime(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ms).toLocaleDateString();
}

function describe(status: SyncStatus, now: number): string {
  switch (status.state) {
    case 'syncing':
      return 'Syncing…';
    case 'idle':
      return status.lastSyncedAt ? `Synced ${relativeTime(status.lastSyncedAt, now)}` : 'Sync is on';
    case 'offline':
      return status.message ?? 'Offline';
    case 'locked':
      return status.message ?? 'Sync isn’t set up on this device';
    case 'error':
      return status.message ?? 'Sync failed';
    default:
      return '';
  }
}

const CLOUD = 'M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z';

/**
 * Compact cloud-sync status for the gallery header. Renders nothing unless sync applies
 * (Supabase configured and signed in). Tap to sync now; when sync isn't set up, opens Settings.
 */
export function SyncIndicator() {
  const status = useSyncStatus();
  const router = useRouter();
  const [now, setNow] = useState(() => Date.now());

  // Keep "Synced 3 min ago" fresh
  useEffect(() => {
    if (status.state === 'disabled') return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [status.state]);

  if (status.state === 'disabled') return null;

  const label = describe(status, now);
  const tone =
    status.state === 'error'
      ? 'text-red-600 dark:text-red-400'
      : status.state === 'locked' || status.state === 'offline'
        ? 'text-gray-400 dark:text-gray-500'
        : 'text-gray-500 dark:text-gray-400';

  return (
    <button
      type="button"
      onClick={() => (status.state === 'locked' ? router.push('/settings') : void requestSync())}
      className={`flex h-11 w-11 items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-neutral-800 ${tone}`}
      aria-label={label}
      title={label}
      data-testid="sync-indicator"
      data-state={status.state}
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={CLOUD} />
        {status.state === 'idle' && <path d="m9.5 14.5 2 2 3.5-4" />}
        {status.state === 'syncing' && (
          <g className="origin-[12px_15px] animate-spin">
            <path d="M14.5 15a2.5 2.5 0 1 1-.73-1.77" />
          </g>
        )}
        {status.state === 'offline' && <line x1="3" y1="3" x2="21" y2="21" />}
        {status.state === 'locked' && (
          <>
            <rect x="10" y="14" width="5" height="4" rx="1" />
            <path d="M11 14v-1a1.5 1.5 0 0 1 3 0v1" />
          </>
        )}
        {status.state === 'error' && (
          <>
            <line x1="12.5" y1="12" x2="12.5" y2="15" />
            <line x1="12.5" y1="17.5" x2="12.5" y2="17.5" />
          </>
        )}
      </svg>
    </button>
  );
}
