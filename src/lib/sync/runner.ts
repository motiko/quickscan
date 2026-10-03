import { liveQuery } from 'dexie';
import { db } from '@/lib/db';
import { getDeviceId } from '@/lib/outbox';
import { getAuthState, subscribeAuth, type AuthState } from '@/lib/auth';
import { getSupabase, isSupabaseConfigured } from '@/lib/supabase';
import { loadVaultKey, type VaultKey } from '@/lib/crypto';
import { isVaultKeyRevoked, retryPendingVaultForget, VAULT_CHANGED_EVENT } from '@/lib/vault-session';
import type { Page } from '@/types';
import { createSupabaseBackend, type SupabaseLike, type SyncBackend } from './backend';
import { runSync, type SyncReport } from './engine';
import { withSyncLock, type LockManagerLike } from './lock';
import { withTimeout } from '@/lib/timeout';
import { RetryTracker } from './state';
import { classifyMessage, classifySyncError, SYNC_ERROR_TEXT } from './errors';
import { getSyncStatus, setSyncStatus, type SyncProblem } from './status';

/*
 * When sync runs: `requestSync()` (coalesced — a request during a run queues exactly one more
 * run), plus the triggers wired by `startSyncScheduler()`: app start, sign-in, focus and
 * network regained, 5 s after a local change, every 5 minutes, and `quickscan:vault-changed`.
 * A run happens only with Supabase configured, a signed-in user and a vault key on this
 * device; otherwise the status says why and nothing is sent.
 */

export { VAULT_CHANGED_EVENT };
export const LOCAL_CHANGE_DELAY_MS = 5_000;
export const PERIODIC_SYNC_MS = 5 * 60_000;
const FOCUS_MIN_INTERVAL_MS = 10_000;
const LOAD_KEY_TIMEOUT_MS = 10_000;

export interface SyncEnvironment {
  isConfigured(): boolean;
  getAuth(): AuthState;
  subscribeAuth(listener: () => void): () => void;
  getBackend(): Promise<SyncBackend>;
  /** The vault key, only if it belongs to this account. */
  loadKey(userId: string): Promise<VaultKey | null>;
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

/** The stored vault key if `vaultOwner` (set by vault-session.ts) says it's this account's. */
async function loadOwnVaultKey(userId: string): Promise<VaultKey | null> {
  // Being forgotten (sign-out) but maybe not deleted yet: never use it
  if (isVaultKeyRevoked()) return null;
  const owner = (await db.syncMeta.get('vaultOwner'))?.value;
  return owner === userId ? loadVaultKey() : null;
}

const defaultEnvironment: SyncEnvironment = {
  isConfigured: isSupabaseConfigured,
  getAuth: getAuthState,
  subscribeAuth,
  getBackend: async () => createSupabaseBackend((await getSupabase()) as unknown as SupabaseLike),
  loadKey: loadOwnVaultKey,
  getDeviceId,
  now: () => Date.now(),
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  makeThumbnail: defaultThumbnail,
};

let env: SyncEnvironment = defaultEnvironment;
const retry = new RetryTracker();
let runFailures = 0;
let runRetryAt: number | undefined;
let retryBadRows = false;
let current: Promise<void> | null = null;
let again = false;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

/** Tests: swap parts of the environment. Returns a function restoring the default. */
export function setSyncEnvironment(overrides: Partial<SyncEnvironment>): () => void {
  env = { ...defaultEnvironment, ...overrides };
  retry.clear();
  runFailures = 0;
  runRetryAt = undefined;
  retryBadRows = false;
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

/**
 * The user pressed Retry: forget every backoff, read rows that couldn't be read again, and
 * sync now.
 */
export function retrySync(): Promise<void> {
  retry.clear();
  runFailures = 0;
  runRetryAt = undefined;
  retryBadRows = true;
  return requestSync();
}

function currentProblems(): SyncProblem[] {
  return retry.problems().map((p) => ({
    stage: p.stage,
    kind: p.kind,
    id: p.id,
    message: p.message,
    code: classifyMessage(p.message),
    attempts: p.attempts,
    retryAt: p.notBefore,
  }));
}

function summarize(report: SyncReport, problems: SyncProblem[]): { message: string; code?: SyncProblem['code'] } | undefined {
  const failing = new Set([
    ...problems.map((p) => `${p.stage}:${p.kind}:${p.id}`),
    ...report.issues.map((i) => `${i.stage}:${i.kind}:${i.id}`),
  ]);
  if (failing.size === 0) return undefined;
  const quota = problems.find((p) => p.code === 'quota');
  if (quota) return { message: SYNC_ERROR_TEXT.quota, code: 'quota' };
  const auth = problems.find((p) => p.code === 'auth');
  if (auth) return { message: SYNC_ERROR_TEXT.auth, code: 'auth' };
  const n = failing.size;
  return { message: `${n} item${n === 1 ? '' : 's'} couldn’t sync. They’ll be retried.` };
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
    setSyncStatus({ state: 'offline', code: 'offline', message: 'Offline. Changes sync when you’re back online.' });
    return null;
  }
  let vault: VaultKey | null;
  try {
    // A blocked or hung database must not leave this run (and every later one) pending forever
    vault = await withTimeout(env.loadKey(auth.user.id), LOAD_KEY_TIMEOUT_MS, 'Loading the vault key');
  } catch (err) {
    console.warn('Sync: could not load the vault key', err);
    runFailures++;
    runRetryAt = env.now() + Math.min(5 * 60_000, 5_000 * 2 ** (runFailures - 1));
    setSyncStatus({ state: 'error', code: 'unknown', message: SYNC_ERROR_TEXT.unknown });
    return null;
  }
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
      const rereadBadRows = retryBadRows;
      retryBadRows = false;
      return runSync({
        backend: await env.getBackend(),
        userId: auth.user.id,
        vault,
        deviceId: await env.getDeviceId(),
        now: () => env.now(),
        retry,
        makeThumbnail: env.makeThumbnail,
        retryBadRows: rereadBadRows,
      });
    }, env.locks);
    runFailures = 0;
    runRetryAt = undefined;
    if (!report) {
      // Signed out or switched accounts while waiting; the auth listener queues the next run
      setSyncStatus({ state: 'idle' });
      return null;
    }
    if (report.accountSwitch) {
      // Another account's documents are here: wait for the user's answer (Settings)
      setSyncStatus({
        state: 'paused',
        message: 'Sync is paused: documents from another account are on this device.',
        accountSwitch: report.accountSwitch,
      });
      return report;
    }
    const problems = currentProblems();
    const facts = { lastSyncedAt: env.now(), problems, pendingDownloads: report.pendingDownloads };
    const problem = summarize(report, problems);
    setSyncStatus(problem ? { state: 'error', ...problem, ...facts } : { state: 'idle', ...facts });
    return report;
  } catch (err) {
    runFailures++;
    runRetryAt = env.now() + Math.min(5 * 60_000, 5_000 * 2 ** (runFailures - 1));
    const code = !env.isOnline() ? 'offline' : classifySyncError(err);
    if (code === 'offline') {
      setSyncStatus({ state: 'offline', code, message: 'Can’t reach the server. Retrying soon.' });
    } else {
      if (code === 'unknown') console.warn('Sync failed:', err);
      setSyncStatus({ state: 'error', code, message: SYNC_ERROR_TEXT[code] });
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
  // A sign-out that couldn't delete the vault key left it for now
  void retryPendingVaultForget();
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
