'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { db } from '@/lib/db';
import { getDatabaseStatus, openDatabase, subscribeDatabaseStatus, type DatabaseStatus } from '@/lib/db-status';

const SERVER_STATUS: DatabaseStatus = { state: 'opening' };

const COPY: Record<'blocked' | 'slow' | 'outdated' | 'error', { title: string; message: string }> = {
  blocked: {
    title: 'QuickScan was updated',
    message:
      'Another QuickScan tab or the home-screen app is still running the old version. Close the other QuickScan tabs and the QuickScan app (swipe it away), and this page continues by itself. Your documents are safe.',
  },
  slow: {
    title: 'Opening your documents takes longer than usual',
    message:
      'If QuickScan is open in another tab or as the home-screen app, close it there; this page continues by itself. Otherwise try reloading. Your documents are safe.',
  },
  outdated: {
    title: 'QuickScan was updated',
    message: 'A newer version of QuickScan was opened in another tab. Reload to continue with it.',
  },
  error: {
    title: 'Couldn’t open your documents',
    message: 'QuickScan couldn’t open its storage on this device. Close other QuickScan tabs, then reload.',
  },
};

/**
 * Opens the local database at start and, if that can't finish (an upgrade blocked by another
 * tab, a newer version elsewhere, an error), says so full screen instead of leaving every
 * page on "Loading..." (see lib/db-status.ts). Renders nothing while all is well.
 */
export function DatabaseGate() {
  const status = useSyncExternalStore(subscribeDatabaseStatus, getDatabaseStatus, () => SERVER_STATUS);

  useEffect(() => {
    void openDatabase(db);
  }, []);

  if (status.state === 'opening' || status.state === 'ready') return null;
  const copy = COPY[status.state];

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="database-gate-title"
      aria-describedby="database-gate-message"
      data-testid="database-gate"
      data-state={status.state}
      className="fixed inset-0 z-[200] flex items-center justify-center bg-white/95 p-6 dark:bg-neutral-950/95"
    >
      <div className="w-full max-w-sm text-center">
        <h2 id="database-gate-title" className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {copy.title}
        </h2>
        <p id="database-gate-message" className="mt-2 text-sm text-gray-600 dark:text-gray-300">
          {copy.message}
        </p>
        {status.state === 'error' && (
          <p className="mt-2 break-words text-xs text-gray-500 dark:text-gray-400">{status.message}</p>
        )}
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="mt-5 min-h-11 w-full rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
