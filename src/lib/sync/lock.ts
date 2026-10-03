/*
 * One sync run at a time across every tab of this origin, via the Web Locks API. Browsers
 * without it (Safari before 15.4) fall back to serializing runs within the tab; two such tabs
 * may then overlap, which is safe (pushes are idempotent last-write-wins, pulls apply rows
 * under the same rules) just wasteful.
 */

export const SYNC_LOCK_NAME = 'quickscan-sync';

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

function defaultLocks(): LockManagerLike | undefined {
  const locks = (globalThis.navigator as (Navigator & { locks?: LockManagerLike }) | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : undefined;
}

let tail: Promise<unknown> = Promise.resolve();

export function withSyncLock<T>(fn: () => Promise<T>, locks: LockManagerLike | null | undefined = defaultLocks()): Promise<T> {
  if (locks) return locks.request(SYNC_LOCK_NAME, () => fn());
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}
