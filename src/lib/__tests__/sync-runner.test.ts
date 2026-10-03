import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import { createDocument } from '@/hooks/useDocuments';
import { generateVaultKey, type VaultKey } from '@/lib/crypto';
import type { AuthState } from '@/lib/auth';
import { createSupabaseBackend } from '@/lib/sync/backend';
import { requestSync, setSyncEnvironment, syncOnce } from '@/lib/sync/runner';
import { getSyncStatus } from '@/lib/sync/status';
import { readOutbox } from '@/lib/outbox';
import { FakeSupabase } from './fake-supabase';

const USER = '00000000-0000-4000-8000-00000000000a';
const signedIn: AuthState = { status: 'signed-in', user: { id: USER, email: 'a@example.com' } };

let vault: VaultKey;
let server: FakeSupabase;
let restore: () => void;

function env(overrides: Parameters<typeof setSyncEnvironment>[0] = {}) {
  restore = setSyncEnvironment({
    isConfigured: () => true,
    getAuth: () => signedIn,
    subscribeAuth: () => () => {},
    getBackend: async () => createSupabaseBackend(server.asClient()),
    loadKey: async () => vault,
    isOnline: () => true,
    locks: null,
    makeThumbnail: undefined,
    ...overrides,
  });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  vault = { key: await generateVaultKey(), keyVersion: 1 };
  server = new FakeSupabase(USER);
});

afterEach(() => restore?.());

describe('syncOnce gating', () => {
  it('stays disabled and sends nothing when Supabase is off', async () => {
    env({ isConfigured: () => false });
    await createDocument('Doc', new Blob(['x']));
    expect(await syncOnce()).toBeNull();
    expect(getSyncStatus().state).toBe('disabled');
    expect(server.log).toEqual([]);
    expect(await readOutbox()).toHaveLength(2);
  });

  it('stays disabled when signed out', async () => {
    env({ getAuth: () => ({ status: 'signed-out' }) });
    expect(await syncOnce()).toBeNull();
    expect(getSyncStatus().state).toBe('disabled');
    expect(server.log).toEqual([]);
  });

  it('is locked without a vault key for this account', async () => {
    const loadKey = vi.fn(async () => null);
    env({ loadKey });
    expect(await syncOnce()).toBeNull();
    expect(getSyncStatus().state).toBe('locked');
    expect(loadKey).toHaveBeenCalledWith(USER);
    expect(server.log).toEqual([]);
  });

  it('is offline without a network', async () => {
    env({ isOnline: () => false });
    expect(await syncOnce()).toBeNull();
    expect(getSyncStatus().state).toBe('offline');
  });

  it('syncs and reports idle with the last synced time', async () => {
    env({ now: () => 1_000_000 });
    await createDocument('Doc', new Blob(['x']));
    const report = await syncOnce();
    expect(report?.pushed).toBe(2);
    expect(getSyncStatus()).toMatchObject({ state: 'idle', lastSyncedAt: 1_000_000 });
    expect(await readOutbox()).toEqual([]);
  });

  it('reports a server failure as an error and network failures as offline', async () => {
    env();
    server.failPullAfter = 0;
    await syncOnce();
    expect(getSyncStatus().state).toBe('offline');

    env({ getBackend: async () => ({ ...createSupabaseBackend(server.asClient()), pullRecords: async () => { throw new Error('boom'); } }) });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await syncOnce();
    expect(getSyncStatus()).toMatchObject({ state: 'error' });
  });

  it('runs under the sync lock', async () => {
    const request = vi.fn((_name: string, cb: () => Promise<unknown>) => cb());
    env({ locks: { request: request as <T>(n: string, cb: () => Promise<T>) => Promise<T> } });
    await syncOnce();
    expect(request).toHaveBeenCalledWith('quickscan-sync', expect.any(Function));
  });
});

describe('requestSync', () => {
  it('coalesces requests during a run into one more run', async () => {
    env();
    const runs = vi.spyOn(server, 'rpc');
    await createDocument('Doc', new Blob(['x']));
    const a = requestSync();
    const b = requestSync();
    const c = requestSync();
    expect(a).toBe(b);
    expect(b).toBe(c);
    await a;
    // Two runs: the first pushes, the queued one finds nothing new to push
    expect(runs).toHaveBeenCalledTimes(1);
    expect(server.log.filter((l) => l.startsWith('pull:')).length).toBeGreaterThanOrEqual(2);
  });
});
