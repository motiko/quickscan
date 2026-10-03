import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import { createDocument } from '@/hooks/useDocuments';
import { generateVaultKey, type VaultKey } from '@/lib/crypto';
import type { AuthState } from '@/lib/auth';
import { createSupabaseBackend, SyncBackendError } from '@/lib/sync/backend';
import { requestSync, retrySync, setSyncEnvironment, syncOnce } from '@/lib/sync/runner';
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

describe('surfacing problems', () => {
  it('lists items failing to upload, with a storage-full hint for 413', async () => {
    env({ now: () => 1_000_000 });
    await createDocument('Doc', new Blob(['x']));
    server.failUploads = 1;
    server.failUploadStatus = '413';
    await syncOnce();
    const status = getSyncStatus();
    expect(status).toMatchObject({ state: 'error', code: 'quota' });
    expect(status.problems).toEqual([
      expect.objectContaining({ stage: 'upload', kind: 'page', code: 'quota', attempts: 1, retryAt: 1_005_000 }),
    ]);
  });

  it('keeps showing an item that is still backing off, and clears it once it syncs', async () => {
    let now = 1_000_000;
    env({ now: () => now });
    await createDocument('Doc', new Blob(['x']));
    server.failUploads = 1;
    await syncOnce();
    await syncOnce(); // backing off: not attempted, still a problem
    expect(getSyncStatus()).toMatchObject({ state: 'error', problems: [expect.objectContaining({ stage: 'upload' })] });
    now += 10_000;
    await syncOnce();
    expect(getSyncStatus()).toMatchObject({ state: 'idle', problems: [] });
  });

  it('retrySync retries at once, ignoring the backoff', async () => {
    env({ now: () => 1_000_000 });
    await createDocument('Doc', new Blob(['x']));
    server.failUploads = 1;
    await syncOnce();
    await retrySync();
    expect(getSyncStatus()).toMatchObject({ state: 'idle', problems: [] });
    expect(await readOutbox()).toEqual([]);
  });

  it('counts files not downloaded yet', async () => {
    env();
    const path = `${USER}/missing-file`;
    await server.remoteRecord(vault.key, {
      kind: 'page',
      id: 'p1',
      updatedAt: Date.now(),
      value: { documentId: 'd1', pageNumber: 1, filter: 'original', createdAt: new Date(), file: { id: 'missing-file', type: 'image/jpeg' } },
      files: [path],
    });
    await syncOnce();
    expect(getSyncStatus()).toMatchObject({
      state: 'error',
      pendingDownloads: 1,
      problems: [expect.objectContaining({ stage: 'download', id: 'p1' })],
    });
  });

  it('records unreadable rows and reads them again on retry', async () => {
    env();
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'ok', updatedAt: Date.now(), value: { name: 'OK', createdAt: new Date() } });
    server.write({ kind: 'folder', id: 'bad', updatedAt: Date.now(), deviceId: 'x', deleted: false, keyVersion: 1, payload: new Uint8Array(40), files: [] });
    await syncOnce();
    const key = `sync:bad:${USER}`;
    expect((await db.syncMeta.get(key))?.value).toEqual([expect.objectContaining({ kind: 'folder', id: 'bad' })]);

    // Retry reads it again from before its seq; still unreadable, so it stays listed
    server.log = [];
    await retrySync();
    expect(server.log).toContain('pull:0');
    expect((await db.syncMeta.get(key))?.value).toHaveLength(1);

    // Replaced by a readable version: the problem goes away
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'bad', updatedAt: Date.now() + 1, value: { name: 'OK', createdAt: new Date() } });
    await syncOnce();
    expect(await db.syncMeta.get(key)).toBeUndefined();
  });

  it('says the session expired on 401 and points to recovery on a key mismatch', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    env({
      getBackend: async () => ({
        ...createSupabaseBackend(server.asClient()),
        pullRecords: async () => {
          throw new SyncBackendError('Pull: JWT expired', { status: 401 });
        },
      }),
    });
    await syncOnce();
    expect(getSyncStatus()).toMatchObject({ state: 'error', code: 'auth', message: expect.stringMatching(/sign in again/i) });

    env();
    await server.remoteRecord(await generateVaultKey(), { kind: 'folder', id: 'f', updatedAt: Date.now(), value: { name: 'X', createdAt: new Date() } });
    await syncOnce();
    expect(getSyncStatus()).toMatchObject({ state: 'error', code: 'key-mismatch', message: expect.stringMatching(/recovery key/i) });
  });
});
