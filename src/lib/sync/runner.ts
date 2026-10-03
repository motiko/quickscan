import { liveQuery } from 'dexie';
import { db } from '@/lib/db';
import { getDeviceId } from '@/lib/outbox';
import { getAuthState, subscribeAuth, type AuthState } from '@/lib/auth';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { loadVaultKey, type VaultKey } from '@/lib/crypto';
import type { Page } from '@/types';
import { createSupabaseBackend, SyncBackendError, type SupabaseLike, type SyncBackend } from './backend';
import { runSync, SyncError, type SyncReport } from './engine';
import { withSyncLock, type LockManagerLike } from './lock';
import { RetryTracker } from './state';
import { getSyncStatus, setSyncStatus } from './status';

/*
 * When sync runs: `requestSync()` (coalesced — a request during a run queues exactly one more
 * run), plus the triggers wired by `startSyncScheduler()`: app start, sign-in, focus and
 * network regained, 5 s after a local change, every 5 minutes, and `quickscan:vault-changed`.
 * A run happens only with Supabase configured, a signed-in user and a vault key on this
 * device; otherwise the status says why and nothing is sent.
 */

export const VAULT_CHANGED_EVENT = 'quickscan:vault-changed';
export const LOCAL_CHANGE_DELAY_MS = 5_000;
export const PERIODIC_SYNC_MS = 5 * 60_000;
const FOCUS_MIN_INTERVAL_MS = 10_000;

export interface SyncEnvironment {
  isConfigured(): boolean;
  getAuth(): AuthState;
  subscribeAuth(listener: () => void): () => void;
  getBackend(): Promise<SyncBackend>;
  loadKey(): Promise<VaultKey | null>;
  getDeviceId(): Promise<string>;
  now(): number;
  isOnline(): boolean;
  locks?: LockManagerLike | null;
  makeThumbnail?: (page: Page) => Promise<Blob>;
}

async function defaultThumbnail(page: Page): Promise<Blob> {
  const [{ createThumbnail }, { getRenderedBlob }] = await Promise.all([
    import('@/lib/image-processing'),
    import('@/lib/annotations/flatten'),
  ]);
  return createThumbnail(await getRenderedBlob(page));
}

const defaultEnvironment: SyncEnvironment = {
  isConfigured: isSupabaseConfigured,
  getAuth: getAuthState,
  subscribeAuth,
  getBackend: async () => createSupabaseBackend((await getSupabase()) as unknown as SupabaseLike),
  loadKey: loadVaultKey,
  getDeviceId,
  now: () => Date.now(),
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  makeThumbnail: defaultThumbnail,
};

let env: SyncEnvironment = defaultEnvironment;
const retry = new RetryTracker();
let runFailures = 0;
let runRetryAt: number | undefined;
let current: Promise<void> | null = null;
let again = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Tests: swap parts of the environment. Returns a function restoring the default. */
export function setSyncEnvironment(overrides: Partial<SyncEnvironment>): () => void {
  env = { ...defaultEnvironment, ...overrides };
  retry.clear();
  runFailures = 0;
  runRetryAt = undefined;
  return () => {
    env = defaultEnvironment;
  };
}

/** Run sync now, or once more right after the current run. Resolves when that run is done. */
export function requestSync(): Promise<void> {
  if (current) {
    again = true;
    return current;
  }
  current = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      current = null;
      scheduleRetry();
    }
  })();
  return current;
}

function summarize(report: SyncReport): string | undefined {
  if (report.issues.length === 0) return undefined;
  const n = report.issues.length;
  return `${n} item${n === 1 ? '' : 's'} couldn’t sync. They’ll be retried.`;
}

/** One gated run: checks configuration, account, network and vault key, then syncs under the lock. */
export async function syncOnce(): Promise<SyncReport | null> {
  if (!env.isConfigured()) {
    setSyncStatus({ state: 'disabled' });
    return null;
  }
  const auth = env.getAuth();
  if (auth.status !== 'signed-in') {
    // Still loading: say nothing yet; signed out: sync doesn't apply
    setSyncStatus({ state: 'disabled' });
    return null;
  }
  if (!env.isOnline()) {
    setSyncStatus({ state: 'offline', message: 'Offline. Changes sync when you’re back online.' });
    return null;
  }
  const vault = await env.loadKey();
  if (!vault) {
    setSyncStatus({ state: 'locked', message: 'Set up sync in Settings to back up your documents.' });
    return null;
  }

  setSyncStatus({ state: 'syncing' });
  try {
    const report = await withSyncLock(async () => {
      // The account may have changed while this tab waited for the lock
      const latest = env.getAuth();
      if (latest.status !== 'signed-in' || latest.user.id !== auth.user.id) return null;
      return runSync({
        backend: await env.getBackend(),
        userId: auth.user.id,
        vault,
        deviceId: await env.getDeviceId(),
        now: () => env.now(),
        retry,
        makeThumbnail: env.makeThumbnail,
      });
    }, env.locks);
    runFailures = 0;
    runRetryAt = undefined;
    if (!report) {
      // Signed out or switched accounts while waiting; the auth listener queues the next run
      setSyncStatus({ state: 'idle' });
      return null;
    }
    const problem = summarize(report);
    setSyncStatus(
      problem ? { state: 'error', message: problem, lastSyncedAt: env.now() } : { state: 'idle', lastSyncedAt: env.now() }
    );
    return report;
  } catch (err) {
    runFailures++;
    runRetryAt = env.now() + Math.min(5 * 60_000, 5_000 * 2 ** (runFailures - 1));
    if (err instanceof SyncError) {
      setSyncStatus({ state: 'error', message: err.message });
    } else if ((err instanceof SyncBackendError && err.network) || !env.isOnline()) {
      setSyncStatus({ state: 'offline', message: 'Can’t reach the server. Retrying soon.' });
    } else {
      console.warn('Sync failed:', err);
      setSyncStatus({ state: 'error', message: 'Sync failed. Retrying soon.' });
    }
    return null;
  }
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  if (!schedulerActive) return;
  const candidates = [runRetryAt, retry.nextRetryAt()].filter((t): t is number => t !== undefined);
  if (candidates.length === 0) return;
  const delay = Math.max(1_000, Math.min(...candidates) - env.now());
  retryTimer = setTimeout(() => void requestSync(), delay);
}

let schedulerActive = false;

/**
 * Wire the triggers (browser only). Does nothing when Supabase isn't configured, so the
 * local-only app behaves exactly as before. Returns a cleanup function.
 */
export function startSyncScheduler(): () => void {
  if (!env.isConfigured() || typeof window === 'undefined') return () => {};
  schedulerActive = true;
  const cleanups: (() => void)[] = [];
  const trigger = () => void requestSync();

  // Sign-in, sign-out, switching accounts
  const authKey = (a: AuthState) => (a.status === 'signed-in' ? `in:${a.user.id}` : a.status);
  let lastAuth = authKey(env.getAuth());
  cleanups.push(
    env.subscribeAuth(() => {
      const next = authKey(env.getAuth());
      if (next === lastAuth) return;
      lastAuth = next;
      retry.clear();
      trigger();
    })
  );

  // Focus and network
  let lastFocusRun = 0;
  const onFocus = () => {
    if (document.visibilityState !== 'visible') return;
    if (env.now() - lastFocusRun < FOCUS_MIN_INTERVAL_MS) return;
    lastFocusRun = env.now();
    trigger();
  };
  const onOffline = () => {
    if (getSyncStatus().state !== 'disabled') setSyncStatus({ state: 'offline', message: 'Offline. Changes sync when you’re back online.' });
  };
  window.addEventListener('focus', onFocus);
  document.addEventListener('visibilitychange', onFocus);
  window.addEventListener('online', trigger);
  window.addEventListener('offline', onOffline);
  window.addEventListener(VAULT_CHANGED_EVENT, trigger);
  cleanups.push(() => {
    window.removeEventListener('focus', onFocus);
    document.removeEventListener('visibilitychange', onFocus);
    window.removeEventListener('online', trigger);
    window.removeEventListener('offline', onOffline);
    window.removeEventListener(VAULT_CHANGED_EVENT, trigger);
  });

  // Every 5 minutes while open
  const interval = setInterval(trigger, PERIODIC_SYNC_MS);
  cleanups.push(() => clearInterval(interval));

  // 5 s after a local change: the newest outbox clock only grows when something is written
  // locally (acks remove entries, pulled changes don't touch the outbox)
  let newest: number | undefined;
  let first = true;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const subscription = liveQuery(() => db.outbox.orderBy('updatedAt').last()).subscribe({
    next: (entry) => {
      const clock = entry?.updatedAt;
      if (first) {
        // What's pending at start goes with the start-up run
        first = false;
        newest = clock;
        return;
      }
      if (clock === undefined || (newest !== undefined && clock <= newest)) return;
      newest = clock;
      clearTimeout(debounce);
      debounce = setTimeout(trigger, LOCAL_CHANGE_DELAY_MS);
    },
    error: (err) => console.warn('Sync: outbox watch failed', err),
  });
  cleanups.push(() => {
    subscription.unsubscribe();
    clearTimeout(debounce);
  });

  trigger();

  return () => {
    schedulerActive = false;
    clearTimeout(retryTimer);
    for (const cleanup of cleanups) cleanup();
  };
}
