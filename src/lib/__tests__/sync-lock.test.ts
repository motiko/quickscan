import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncLockTimeoutError, withSyncLock, type LockManagerLike } from '@/lib/sync/lock';

/*
 * The sync lock must never wait forever: in-app web views (Chrome on iOS) may lack Web Locks or
 * behave oddly, and a frozen tab may hold the lock indefinitely.
 */

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('withSyncLock timeouts', () => {
  it('gives up when the lock is never granted, and releases a late grant at once', async () => {
    let grant!: () => Promise<unknown>;
    const stuck: LockManagerLike = {
      request: <T,>(_name: string, cb: () => Promise<T>) => {
        grant = cb;
        return new Promise<T>(() => {});
      },
    };
    const fn = vi.fn(async () => 'ran');
    await expect(withSyncLock(fn, stuck, { acquireTimeoutMs: 20 })).rejects.toBeInstanceOf(SyncLockTimeoutError);

    // Granted after giving up: the work doesn't run and the lock is handed back straight away
    await expect(grant()).resolves.toBeUndefined();
    expect(fn).not.toHaveBeenCalled();
  });

  it('fails instead of hanging when the lock manager throws or rejects', async () => {
    const throwing: LockManagerLike = {
      request: () => {
        throw new TypeError('locks.request is not supported here');
      },
    };
    await expect(withSyncLock(async () => 1, throwing)).rejects.toThrow('not supported');
    const rejecting: LockManagerLike = { request: () => Promise.reject(new DOMException('nope', 'SecurityError')) };
    await expect(withSyncLock(async () => 1, rejecting)).rejects.toThrow('nope');
  });

  it('without Web Locks, a run stuck forever doesn’t block the next one past the hold limit', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hung = withSyncLock(() => new Promise<never>(() => {}), null, { holdTimeoutMs: 20, acquireTimeoutMs: 1_000 });
    void hung;
    await expect(withSyncLock(async () => 'next', null, { acquireTimeoutMs: 1_000 })).resolves.toBe('next');
  });

  it('without Web Locks, waiting behind a long run times out', async () => {
    let release!: () => void;
    const long = withSyncLock(() => new Promise<void>((r) => (release = r)), null);
    await expect(withSyncLock(async () => 'next', null, { acquireTimeoutMs: 20 })).rejects.toBeInstanceOf(SyncLockTimeoutError);
    release();
    await long;
    // The queue keeps working afterwards
    await expect(withSyncLock(async () => 'again', null)).resolves.toBe('again');
  });

  it('with native Web Locks missing on navigator, falls back to the tab queue', async () => {
    vi.stubGlobal('navigator', {});
    await expect(withSyncLock(async () => 'ok')).resolves.toBe('ok');
    vi.unstubAllGlobals();
  });
});
