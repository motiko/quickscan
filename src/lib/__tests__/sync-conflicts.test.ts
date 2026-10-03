import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import { createDocument, deletePage, keepConflictedCopy, renameDocument, savePageAnnotations } from '@/hooks/useDocuments';
import { applyUntracked, getDeviceId, readOutbox } from '@/lib/outbox';
import { MAX_CLOCK_LEAD_MS, writeClock } from '@/lib/sync-tracking';
import { encryptRecord, generateVaultKey, type VaultKey } from '@/lib/crypto';
import { createSupabaseBackend } from '@/lib/sync/backend';
import { orderPages, runSync, type SyncContext } from '@/lib/sync/engine';
import { chooseUploadToAccount, removePreviousAccountData } from '@/lib/sync/account-switch';
import { badRowsKey, getMeta, markKey, RetryTracker, type BadRow, type RecordMark } from '@/lib/sync/state';
import { materialHash } from '@/lib/sync/payload';
import { FakeSupabase } from './fake-supabase';
import type { Annotation, Page } from '@/types';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const TABLES = ['documents', 'pages', 'folders', 'signatures', 'settings', 'outbox', 'syncMeta'] as const;

let vault: VaultKey;
/** Real time, advanced by the tests; each device sees it plus its own skew. */
let wall: number;
let current: string;
let skew: Record<string, number>;
const saved = new Map<string, Record<string, unknown[]>>();

const img = (s: string) => new Blob([s], { type: 'image/jpeg' });
const rect = (id: string, x: number): Annotation => ({ id, type: 'rect', x, y: 0, w: 0.2, h: 0.2, color: '#f00', width: 0.01 });

/**
 * Two (or more) devices share one fake IndexedDB: switching saves this device's tables and
 * loads the other's, untracked, so each keeps its own outbox, device id and markers.
 */
async function device(name: string): Promise<void> {
  if (name === current) return;
  const snapshot: Record<string, unknown[]> = {};
  for (const t of TABLES) snapshot[t] = await db.table(t).toArray();
  saved.set(current, snapshot);
  const next = saved.get(name);
  await applyUntracked(async () => {
    for (const t of TABLES) {
      await db.table(t).clear();
      if (next) await db.table(t).bulkPut(next[t]);
    }
  });
  current = name;
}

async function sync(server: FakeSupabase, overrides: Partial<SyncContext> = {}) {
  return runSync({
    backend: createSupabaseBackend(server.asClient()),
    userId: server.userId,
    vault,
    deviceId: await getDeviceId(),
    now: () => Date.now(),
    retry: new RetryTracker(),
    ...overrides,
  });
}

/** A fake server whose clock (for its +5 min clamp) is the true time, not a device's. */
function newServer(userId: string): FakeSupabase {
  const server = new FakeSupabase(userId);
  server.now = () => wall;
  return server;
}

const tick = (ms = 1000) => {
  wall += ms;
};

/** `savePageAnnotations` on a first page touches its document too; these tests look at pages. */
const pageConflicts = (report: { conflicts: { kind: string }[] }) => report.conflicts.filter((c) => c.kind === 'page');

async function pagesOf(docId: string) {
  const pages = await db.pages.where('documentId').equals(docId).sortBy('pageNumber');
  return pages.map((p) => ({ annotations: p.annotations ?? [], conflictOf: p.conflictOf ?? null, id: p.id }));
}

beforeEach(async () => {
  await db.delete();
  await db.open();
  vault = { key: await generateVaultKey(), keyVersion: 1 };
  wall = Date.UTC(2026, 9, 3, 12);
  current = 'A';
  skew = {};
  saved.clear();
  vi.spyOn(Date, 'now').mockImplementation(() => wall + (skew[current] ?? 0));
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Device A scans a document; both A and B have synced it. Returns the doc and page ids. */
async function sharedDocument(server: FakeSupabase): Promise<{ docId: string; pageId: string }> {
  await device('A');
  const docId = await createDocument('Lease', img('page'));
  const [page] = await db.pages.where('documentId').equals(docId).toArray();
  await sync(server);
  tick();
  await device('B');
  await sync(server);
  tick();
  await device('A');
  await sync(server);
  tick();
  return { docId, pageId: page.id };
}

describe('conflicted copies', () => {
  it('keeps the losing local annotations as a copy, and both devices converge', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);

    // Both annotate the same page offline; B's edit is later, but A syncs first
    await device('A');
    await savePageAnnotations(pageId, [rect('a', 0.1)]);
    tick();
    await device('B');
    await savePageAnnotations(pageId, [rect('b', 0.5)]);
    tick();

    await device('A');
    await sync(server); // A's edit reaches the server first
    tick();
    await device('B');
    const reportB = await sync(server); // B's later edit wins; B keeps A's version as a copy
    expect(pageConflicts(reportB)).toEqual([expect.objectContaining({ kind: 'page', id: pageId, loser: 'remote', copyId: expect.any(String) })]);
    tick();
    await device('A');
    await sync(server);

    const onA = await pagesOf(docId);
    await device('B');
    const onB = await pagesOf(docId);
    expect(onA).toEqual(onB);
    expect(onA).toHaveLength(2);
    expect(onA[0]).toMatchObject({ id: pageId, annotations: [rect('b', 0.5)], conflictOf: null });
    expect(onA[1]).toMatchObject({ annotations: [rect('a', 0.1)], conflictOf: pageId });
    expect(await readOutbox()).toEqual([]);
    // The copy's image arrived on B too (it reuses the existing file)
    const copy = await db.pages.get(onB[1].id);
    expect(await copy!.processedBlob!.text()).toBe('page');
  });

  it('makes the copy on the losing side when its own edit lost', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);

    await device('A');
    await savePageAnnotations(pageId, [rect('a', 0.1)]);
    tick();
    await device('B');
    await savePageAnnotations(pageId, [rect('b', 0.5)]);
    tick();

    await device('B');
    await sync(server); // the later edit is on the server first
    tick();
    await device('A');
    const reportA = await sync(server);
    expect(pageConflicts(reportA)).toEqual([expect.objectContaining({ id: pageId, loser: 'local', copyId: expect.any(String) })]);
    tick();
    await device('B');
    await sync(server);

    const onB = await pagesOf(docId);
    await device('A');
    expect(await pagesOf(docId)).toEqual(onB);
    expect(onB.map((p) => [p.annotations, p.conflictOf])).toEqual([
      [[rect('b', 0.5)], null],
      [[rect('a', 0.1)], pageId],
    ]);
  });

  it('settles a push that lost to a write made between pull and push', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);

    await device('B');
    await savePageAnnotations(pageId, [rect('b', 0.5)]);
    tick();
    await device('A');
    await savePageAnnotations(pageId, [rect('a', 0.1)]);
    // B edits again and syncs while A is between its pull and its push
    server.beforeUpsert = async () => {
      await device('B');
      tick(5000);
      await savePageAnnotations(pageId, [rect('b', 0.6)]);
      await sync(server);
      await device('A');
    };
    const report = await sync(server);
    expect(report.rejected).toBeGreaterThanOrEqual(1); // the page (and its document)
    expect(pageConflicts(report)).toEqual([expect.objectContaining({ id: pageId, loser: 'local', copyId: expect.any(String) })]);
    expect(await readOutbox()).toEqual([]);
    const onA = await pagesOf(docId);
    expect(onA.map((p) => [p.annotations, p.conflictOf])).toEqual([
      [[rect('b', 0.6)], null],
      [[rect('a', 0.1)], pageId],
    ]);
  });

  it('makes no copy when both devices ended up with the same page', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);
    await device('A');
    await savePageAnnotations(pageId, [rect('same', 0.3)]);
    tick();
    await device('B');
    await savePageAnnotations(pageId, [rect('same', 0.3)]);
    tick();
    await device('A');
    await sync(server);
    tick();
    await device('B');
    const report = await sync(server);
    expect(pageConflicts(report)).toEqual([{ kind: 'page', id: pageId, loser: 'remote' }]);
    expect(await pagesOf(docId)).toHaveLength(1);
  });

  it('makes no copy when the losing edit changed nothing that matters', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);
    // A only renumbers (page order), B annotates; A's later edit wins the page
    await device('B');
    await savePageAnnotations(pageId, [rect('b', 0.5)]);
    tick();
    await sync(server);
    tick();
    await device('A');
    await db.pages.update(pageId, { pageNumber: 2 });
    const report = await sync(server);
    // B's annotation is the loser and matters: it's kept
    expect(pageConflicts(report)).toEqual([expect.objectContaining({ loser: 'remote', copyId: expect.any(String) })]);

    // The other way round: B renumbers, A annotates later and wins; B's version had nothing new
    tick();
    await device('B');
    await sync(server);
    await db.pages.update(pageId, { pageNumber: 2 });
    tick();
    await device('A');
    await savePageAnnotations(pageId, [rect('a', 0.2)]);
    tick();
    await device('B');
    await sync(server);
    tick();
    await device('A');
    const second = await sync(server);
    expect(pageConflicts(second)).toEqual([{ kind: 'page', id: pageId, loser: 'remote' }]);
    expect((await pagesOf(docId)).filter((p) => p.conflictOf)).toHaveLength(1);
  });

  it('keeps document renames last-write-wins and never copies a delete', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);
    await device('A');
    await renameDocument(docId, 'From A');
    tick();
    await device('B');
    await renameDocument(docId, 'From B');
    await savePageAnnotations(pageId, [rect('b', 0.5)]);
    tick();
    await device('A');
    await deletePage(pageId); // deletes the document too (its only page)
    tick();
    await device('B');
    await sync(server);
    tick();
    await device('A');
    const report = await sync(server);
    expect(report.conflicts.every((c) => c.copyId === undefined)).toBe(true);
    // The delete is newer than B's edits: gone on A (no copy)
    expect(await db.pages.count()).toBe(0);
  });

  it('turns a copy into an ordinary page with "Keep"', async () => {
    const server = newServer(USER_A);
    const { docId, pageId } = await sharedDocument(server);
    await device('A');
    await savePageAnnotations(pageId, [rect('a', 0.1)]);
    tick();
    await device('B');
    await savePageAnnotations(pageId, [rect('b', 0.5)]);
    tick();
    await device('A');
    await sync(server);
    tick();
    await device('B');
    await sync(server);
    const copy = (await pagesOf(docId))[1];
    await keepConflictedCopy(copy.id);
    expect((await db.pages.get(copy.id))!.conflictOf).toBeUndefined();
    expect((await readOutbox()).map((e) => e.id)).toContain(copy.id);
  });
});

describe('orderPages', () => {
  it('puts copies right after their original, whatever their numbers', () => {
    const p = (id: string, pageNumber: number, conflictOf?: string) => ({ id, pageNumber, conflictOf });
    const ordered = orderPages([p('a', 1), p('b', 2), p('c', 3), p('x', 3, 'a'), p('w', 1, 'a'), p('y', 1, 'missing')]);
    expect(ordered.map((q) => q.id)).toEqual(['a', 'w', 'x', 'y', 'b', 'c']);
    // A loop of copies still keeps every page
    expect(orderPages([p('m', 1, 'n'), p('n', 2, 'm')]).map((q) => q.id)).toEqual(['m', 'n']);
  });
});

describe('materialHash', () => {
  const base: Pick<Page, 'filter'> = { filter: 'original' };
  it('ignores on-device OCR text but not cloud-model text', () => {
    const at = new Date();
    const tess = (text: string) => ({ ...base, ocrText: text, ocrInfo: { engine: 'tesseract' as const, languages: ['eng'], recognizedAt: at } });
    expect(materialHash(tess('a'))).toBe(materialHash(tess('b')));
    const llm = (text: string) => ({ ...base, ocrText: text, ocrInfo: { engine: 'llm' as const, provider: 'openai' as const, model: 'm', recognizedAt: at } });
    expect(materialHash(llm('a'))).not.toBe(materialHash(llm('b')));
    expect(materialHash({ ...base, rotation: 90 })).not.toBe(materialHash(base));
    expect(materialHash({ ...base, annotations: [] })).toBe(materialHash(base));
  });
});

describe('replay protection', () => {
  async function seedFolder(server: FakeSupabase, name: string, at: number) {
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'f1', updatedAt: at, value: { name, createdAt: new Date(at) } });
  }

  it('rejects a pulled row older than one already applied', async () => {
    const server = newServer(USER_A);
    await seedFolder(server, 'v1', wall - 2000);
    const old = { ...server.get('folder', 'f1')! };
    await sync(server);
    await seedFolder(server, 'v2', wall - 1000);
    await sync(server);
    expect((await db.folders.get('f1'))!.name).toBe('v2');

    // The server serves the old row again, as if new
    server.rows.set(`${USER_A}|folder|f1`, { ...old, seq: ++server.seq });
    const report = await sync(server);
    expect(report.replayed).toBe(1);
    expect((await db.folders.get('f1'))!.name).toBe('v2');
    const bad = (await getMeta<BadRow[]>(badRowsKey(USER_A)))!;
    expect(bad).toEqual([expect.objectContaining({ kind: 'folder', id: 'f1' })]);
  });

  it('rejects an old payload re-dated with a newer row clock', async () => {
    const server = newServer(USER_A);
    await seedFolder(server, 'v1', wall - 2000);
    const old = { ...server.get('folder', 'f1')! };
    await sync(server);
    await seedFolder(server, 'v2', wall - 1000);
    await sync(server);

    server.rows.set(`${USER_A}|folder|f1`, { ...old, updatedAt: wall, seq: ++server.seq });
    const report = await sync(server);
    expect(report.issues).toEqual([expect.objectContaining({ stage: 'pull', id: 'f1', message: expect.stringMatching(/clock/i) })]);
    expect((await db.folders.get('f1'))!.name).toBe('v2');
  });

  it('accepts a row clock the server lowered (its +5 min clamp)', async () => {
    const server = newServer(USER_A);
    // Written by a device whose clock is 10 minutes ahead: the server stores it clamped
    const payload = await encryptRecord(
      vault.key,
      { userId: USER_A, kind: 'folder', id: 'f1' },
      { name: 'ahead', createdAt: new Date(wall) },
      { updatedAt: wall + 10 * 60_000, deviceId: 'fast', deleted: false }
    );
    server.now = () => wall;
    server.write({ kind: 'folder', id: 'f1', updatedAt: wall + 10 * 60_000, deviceId: 'fast', deleted: false, keyVersion: 1, payload, files: [] });
    expect(server.get('folder', 'f1')!.updatedAt).toBe(wall + 5 * 60_000);
    const report = await sync(server);
    expect(report.issues).toEqual([]);
    expect((await db.folders.get('f1'))!.name).toBe('ahead');
  });

  it('still reads v1 payloads, but not a v1 payload after a v2 one', async () => {
    const server = newServer(USER_A);
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'f1', updatedAt: wall - 3000, value: { name: 'legacy', createdAt: new Date() }, format: 1 });
    await sync(server);
    expect((await db.folders.get('f1'))!.name).toBe('legacy');

    await seedFolder(server, 'v2', wall - 2000);
    await sync(server);
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'f1', updatedAt: wall - 1000, value: { name: 'downgrade', createdAt: new Date() }, format: 1 });
    const report = await sync(server);
    expect(report.replayed).toBe(1);
    expect((await db.folders.get('f1'))!.name).toBe('v2');
  });

  it('fails authentication when the server changes the device id or the deletion flag', async () => {
    const server = newServer(USER_A);
    await server.remoteRecord(vault.key, { kind: 'folder', id: 'ok', updatedAt: wall - 2000, value: { name: 'OK', createdAt: new Date() } });
    await seedFolder(server, 'v1', wall - 1000);
    const row = server.get('folder', 'f1')!;
    server.rows.set(`${USER_A}|folder|f1`, { ...row, deviceId: 'someone-else' });
    const report = await sync(server);
    expect(report.issues).toEqual([expect.objectContaining({ stage: 'pull', id: 'f1' })]);
    expect(await db.folders.get('f1')).toBeUndefined();

    // A "tombstone" still carrying a payload isn't something the server stores: refused
    server.rows.set(`${USER_A}|folder|f2`, { ...row, id: 'f2', deleted: true, seq: ++server.seq });
    const second = await sync(server);
    expect(second.issues).toEqual([expect.objectContaining({ id: 'f2' })]);
  });

  it('re-encrypts a v1 record as v2 on the next local write', async () => {
    const server = newServer(USER_A);
    const now = new Date(wall);
    await server.remoteRecord(vault.key, { kind: 'document', id: 'd1', updatedAt: wall - 1000, value: { name: 'old', createdAt: now, updatedAt: now }, format: 1 });
    await sync(server);
    tick();
    await renameDocument('d1', 'new');
    await sync(server);
    expect(server.get('document', 'd1')!.payload![0]).toBe(0x02);
    expect(((await getMeta<RecordMark>(markKey('document', 'd1'))) ?? {}).v2).toBe(true);
  });
});

describe('clock skew', () => {
  it('writeClock stays past what was seen, capped at now + 5 minutes', () => {
    expect(writeClock(1000, undefined)).toBe(1000);
    expect(writeClock(1000, 500)).toBe(1000);
    expect(writeClock(1000, 5000)).toBe(5001);
    expect(writeClock(1000, 1000 + 60 * MAX_CLOCK_LEAD_MS)).toBe(1000 + MAX_CLOCK_LEAD_MS);
  });

  async function renameAfterSeeing(server: FakeSupabase, docId: string) {
    await device('A');
    await renameDocument(docId, 'Renamed on A');
    await sync(server);
    tick();
    await device('B');
    await sync(server);
    expect((await db.documents.get(docId))!.name).toBe('Renamed on A');
    tick();
    // B's wall clock says this is earlier than A's rename
    await renameDocument(docId, 'Renamed later on B');
  }

  it('a device whose clock is behind still wins with an edit made after seeing the other', async () => {
    const server = newServer(USER_A);
    skew = { B: -3 * 60_000 };
    const { docId } = await sharedDocument(server);
    await renameAfterSeeing(server, docId);
    const [entry] = (await readOutbox()).filter((e) => e.kind === 'document');
    expect(entry.updatedAt).toBe(server.get('document', docId)!.updatedAt + 1);
    const report = await sync(server);
    expect(report.rejected).toBe(0);
    tick();
    await device('A');
    await sync(server);
    expect((await db.documents.get(docId))!.name).toBe('Renamed later on B');
  });

  it('beyond the 5-minute cap, the edit is re-queued past the version it was made on and wins next run', async () => {
    const server = newServer(USER_A);
    skew = { B: -10 * 60_000 };
    const { docId } = await sharedDocument(server);
    await renameAfterSeeing(server, docId);
    const [entry] = (await readOutbox()).filter((e) => e.kind === 'document');
    expect(entry.updatedAt).toBe(Date.now() + MAX_CLOCK_LEAD_MS);
    const first = await sync(server);
    expect(first.rejected).toBe(1);
    expect((await db.documents.get(docId))!.name).toBe('Renamed later on B');
    expect(pageConflicts(first)).toEqual([]);
    tick();
    const second = await sync(server);
    expect(second.rejected).toBe(0);
    tick();
    await device('A');
    await sync(server);
    expect((await db.documents.get(docId))!.name).toBe('Renamed later on B');
  });
});

describe('account switch', () => {
  async function deviceWithAccountA() {
    const serverA = newServer(USER_A);
    const synced = await createDocument('Synced to A', img('a'));
    await sync(serverA);
    tick();
    await sync(serverA);
    tick();
    const unsynced = await createDocument('Not synced yet', img('u'));
    return { serverA, synced, unsynced };
  }

  it('uploads nothing until the user chooses, then merges on "Upload"', async () => {
    const { synced, unsynced } = await deviceWithAccountA();
    const serverB = newServer(USER_B);
    for (let i = 0; i < 2; i++) {
      const report = await sync(serverB);
      expect(report.accountSwitch).toEqual({ previousUserId: USER_A, documents: 2, folders: 0, signatures: 0, removed: false });
    }
    expect(serverB.log).toEqual([]);

    await chooseUploadToAccount(USER_B);
    const report = await sync(serverB);
    expect(report.merged).toBe(true);
    expect(serverB.get('document', synced)).toBeDefined();
    expect(serverB.get('document', unsynced)).toBeDefined();
  });

  it('"Remove" drops what is safe in the previous account and keeps the rest, still paused', async () => {
    const { synced, unsynced } = await deviceWithAccountA();
    const serverB = newServer(USER_B);
    expect((await sync(serverB)).accountSwitch).toBeDefined();

    const plan = await removePreviousAccountData(USER_B);
    expect(plan!.documents).toEqual([synced]);
    expect(await db.documents.get(synced)).toBeUndefined();
    expect(await db.documents.get(unsynced)).toBeDefined();

    const report = await sync(serverB);
    expect(report.accountSwitch).toEqual({ previousUserId: USER_A, documents: 1, folders: 0, signatures: 0, removed: true });
    expect(serverB.log).toEqual([]);

    await chooseUploadToAccount(USER_B);
    expect((await sync(serverB)).merged).toBe(true);
    expect(serverB.get('document', unsynced)).toBeDefined();
    expect(serverB.get('document', synced)).toBeUndefined();
  });

  it('merges without asking once nothing from the other account is left', async () => {
    const serverA = newServer(USER_A);
    const docId = await createDocument('Doc', img('a'));
    await sync(serverA);
    tick();
    await sync(serverA);
    await removePreviousAccountData(USER_B);
    expect(await db.documents.get(docId)).toBeUndefined();
    const report = await sync(newServer(USER_B));
    expect(report.accountSwitch).toBeUndefined();
    expect(report.merged).toBe(true);
  });

  it('never asks on a device that has never synced', async () => {
    await createDocument('Local', img('x'));
    const report = await sync(newServer(USER_B));
    expect(report.accountSwitch).toBeUndefined();
    expect(report.merged).toBe(true);
  });
});

describe('OCR for pulled pages', () => {
  async function remotePage(server: FakeSupabase, value: Record<string, unknown>, at: number) {
    const now = new Date(wall);
    await server.remoteRecord(vault.key, { kind: 'document', id: 'd1', updatedAt: at, value: { name: 'Remote', createdAt: now, updatedAt: now } });
    const path = await server.remoteFile(vault.key, 'file-1', img('pixels'));
    await server.remoteRecord(vault.key, {
      kind: 'page',
      id: 'p1',
      updatedAt: at,
      value: { documentId: 'd1', pageNumber: 1, filter: 'original', createdAt: now, file: { id: 'file-1', type: 'image/jpeg' }, ...value },
      files: [path],
    });
  }

  it('queues a pulled page without text once its image is here, exactly once', async () => {
    const server = newServer(USER_A);
    await remotePage(server, {}, wall - 1000);
    await sync(server);
    expect((await db.pages.get('p1'))!.ocrStatus).toBe('pending');

    // Recognized here; the text syncs back as a normal edit
    await db.pages.update('p1', { ocrStatus: 'done', ocrText: 'Hello' });
    expect((await readOutbox()).map((e) => e.id)).toContain('p1');
    tick();
    await sync(server);

    // Another device changes the page (still no text there): not queued again
    tick();
    await remotePage(server, { annotations: [rect('r', 0.1)] }, wall);
    tick();
    await sync(server);
    expect((await db.pages.get('p1'))!.ocrStatus).not.toBe('pending');
  });

  it('does not queue a pulled page that has text', async () => {
    const server = newServer(USER_A);
    await remotePage(server, { ocrText: 'Hi' }, wall - 1000);
    await sync(server);
    expect((await db.pages.get('p1'))!.ocrStatus).toBe('done');
  });
});
