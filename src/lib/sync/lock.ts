/*
 * One sync run at a time across every tab of this origin, via the Web Locks API. Browsers
 * without it (Safari before 15.4, some in-app web views) fall back to serializing runs within
 * the tab; two such tabs may then overlap, which is safe (pushes are idempotent
 * last-write-wins, pulls apply rows under the same rules) just wasteful.
 *
 * Neither may wait forever: a lock held by a frozen tab (iOS suspends background tabs) or a
 * `locks.request` that never calls back must not stall sync, sign-out or removal. Waiting for
 * the lock gives up after `acquireTimeoutMs` with `SyncLockTimeoutError` (the caller reports it
 * and retries later), and a run holding the lock lets go of it after `holdTimeoutMs` (the run
 * itself carries on; overlapping is safe, see above).
 */

export const SYNC_LOCK_NAME = 'quickscan-sync';
export const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;
export const LOCK_HOLD_TIMEOUT_MS = 10 * 60_000;

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export class SyncLockTimeoutError extends Error {
  constructor(ms: number) {
    super(`Waited ${ms} ms for another sync run to finish`);
    this.name = 'SyncLockTimeoutError';
  }
}

export interface SyncLockOptions {
  acquireTimeoutMs?: number;
  holdTimeoutMs?: number;
}

function defaultLocks(): LockManagerLike | undefined {
  try {
    const locks = (globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined)?.locks;
    return locks && typeof locks.request === 'function' ? locks : undefined;
  } catch {
    return undefined;
  }
}

let tail: Promise<unknown> = Promise.resolve();

/** Serialize within this tab only. */
const tabLocks: LockManagerLike = {
  request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    const run = tail.then(callback, callback);
    tail = run.catch(() => undefined);
    return run;
  },
};

export function withSyncLock<T>(
  fn: () => Promise<T>,
  locks: LockManagerLike | null | undefined = defaultLocks(),
  { acquireTimeoutMs = LOCK_ACQUIRE_TIMEOUT_MS, holdTimeoutMs = LOCK_HOLD_TIMEOUT_MS }: SyncLockOptions = {}
): Promise<T> {
  const manager = locks ?? tabLocks;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let granted = false;
    const finish = (ok: boolean, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(acquireTimer);
      if (ok) resolve(value as T);
      else reject(value);
    };
    const acquireTimer = setTimeout(() => {
      if (!granted) finish(false, new SyncLockTimeoutError(acquireTimeoutMs));
    }, acquireTimeoutMs);

    let request: Promise<unknown>;
    try {
      request = manager.request(SYNC_LOCK_NAME, () => {
        granted = true;
        clearTimeout(acquireTimer);
        // Granted after we gave up: release it right away
        if (settled) return Promise.resolve(undefined as T);
        const work = Promise.resolve().then(fn);
        work.then(
          (value) => finish(true, value),
          (err) => finish(false, err)
        );
        // Hold the lock while the run lasts, but never longer than holdTimeoutMs
        return new Promise<T>((release) => {
          const holdTimer = setTimeout(() => {
            console.warn('Sync: a run held the lock too long; releasing it');
            release(undefined as T);
          }, holdTimeoutMs);
          const done = () => {
            clearTimeout(holdTimer);
            release(undefined as T);
          };
          work.then(done, done);
        });
      });
    } catch (err) {
      finish(false, err);
      return;
    }
    // A lock manager that fails to grant (or rejects for its own reasons) fails the call
    Promise.resolve(request).catch((err) => finish(false, err));
  });
}
