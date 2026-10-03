import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import { createDocument, deletePage, addPageToDocument, renameDocument, savePageAnnotations, updatePage } from '@/hooks/useDocuments';
import { createFolder } from '@/lib/folders';
import { readOutbox } from '@/lib/outbox';
import { generateVaultKey, type VaultKey } from '@/lib/crypto';
import { createSupabaseBackend } from '@/lib/sync/backend';
import { runSync, type SyncContext } from '@/lib/sync/engine';
import {
  cleanupOrphanedFiles,
  CLEANUP_INTERVAL_MS,
  FRESH_UPLOAD_MS,
  getCleanupState,
  ORPHAN_GRACE_MS,
  REUSE_WINDOW_MS,
} from '@/lib/sync/cleanup';
import { previewRemoval, removeSyncedFromDevice } from '@/lib/sync/remove-local';
import { getCursor, getFileRef, putFileRef, RetryTracker } from '@/lib/sync/state';
import { getDeviceId } from '@/lib/outbox';
import { FakeSupabase } from './fake-supabase';

const USER = '00000000-0000-4000-8000-00000000000a';
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let vault: VaultKey;
let clock: number;
let server: FakeSupabase;

const img = (s: string) => new Blob([s], { type: 'image/jpeg' });

async function context(overrides: Partial<SyncContext> = {}): Promise<SyncContext> {
  return {
    backend: createSupabaseBackend(server.asClient()),
    userId: USER,
    vault,
    deviceId: await getDeviceId(),
    now: () => clock,
    retry: new RetryTracker(),
    ...overrides,
  };
}

const sync = async (overrides: Partial<SyncContext> = {}) => runSync(await context(overrides));
const cleanup = () => cleanupOrphanedFiles(createSupabaseBackend(server.asClient()), USER, clock, { force: true });
const pagePath = async (pageId: string) => `${USER}/${(await getFileRef('page', pageId))!.fileId}`;

beforeEach(async () => {
  await db.delete();
  await db.open();
  vault = { key: await generateVaultKey(), keyVersion: 1 };
  clock = Date.now();
  server = new FakeSupabase(USER);
  server.now = () => clock;
});

describe('orphaned file cleanup', () => {
  it('deletes a replaced image in two passes a grace period apart, never the current one', async () => {
    const docId = await createDocument('Doc', img('v1'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    await sync();
    await sync(); // past the first-sync merge
    const oldPath = await pagePath(page.id);

    await updatePage(page.id, { processedBlob: img('v2') });
    await sync();
    const newPath = await pagePath(page.id);
    expect(server.objects.size).toBe(2);

    // Fresh uploads aren't even candidates
    clock += FRESH_UPLOAD_MS - 1;
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 0, candidates: 0 });

    // Old enough: seen unreferenced, kept for the grace period
    clock += 2;
    expect(await cleanup()).toMatchObject({ ran: true, deleted: 0, candidates: 1 });
    expect((await getCleanupState(USER))!.candidates).toEqual({ [oldPath]: clock });

    clock += ORPHAN_GRACE_MS - 1;
    expect(await cleanup()).toMatchObject({ deleted: 0, candidates: 1 });
    clock += 1;
    expect(await cleanup()).toMatchObject({ deleted: 1, candidates: 0 });
    expect([...server.objects.keys()]).toEqual([newPath]);
    expect((await getCleanupState(USER))!.usage).toMatchObject({ files: 1, bytes: server.objects.get(newPath)!.size });
  });

  it('runs at most once a day as part of a sync', async () => {
    await createDocument('Doc', img('v1'));
    await sync();
    await sync();
    const lists = () => server.log.filter((l) => l.startsWith('list:')).length;
    expect(lists()).toBe(1);
    clock += CLEANUP_INTERVAL_MS - 1;
    await sync();
    expect(lists()).toBe(1);
    clock += 1;
    const report = await sync();
    expect(lists()).toBe(2);
    expect(report.cleanup).toMatchObject({ ran: true });
  });

  it('removes the images of deleted pages and failed uploads, but nothing a record references', async () => {
    const docId = await createDocument('Doc', img('keep'));
    const second = await addPageToDocument(docId, img('drop'));
    await sync();
    await sync();
    const [kept] = (await db.pages.where('documentId').equals(docId).sortBy('pageNumber'));
    const keptPath = await pagePath(kept.id);
    const droppedPath = await pagePath(second);
    await deletePage(second);

    // An upload whose record never landed (e.g. the push failed for good)
    await server.remoteFile(vault.key, 'stray', img('stray'));
    // Another device's page, referenced on the server but not on this device
    const otherPath = await server.remoteFile(vault.key, 'other-file', img('other'));
    server.write({ kind: 'page', id: 'p-other', updatedAt: clock, deviceId: 'zz', deleted: false, keyVersion: 1, payload: new Uint8Array([1]), files: [otherPath] });
    // This device's upload that isn't pushed yet: mapped locally, unknown to the server
    const pendingPath = await server.remoteFile(vault.key, 'pending', img('pending'));
    await putFileRef({ kind: 'signature', id: 'sig-pending', userId: USER, fileId: 'pending', type: 'image/png', downloaded: true, confirmedAt: clock });

    await sync();
    clock += DAY;
    await cleanup();
    clock += ORPHAN_GRACE_MS;
    const result = await cleanup();
    expect(result.deleted).toBe(2);
    expect(server.objects.has(droppedPath)).toBe(false);
    expect(server.objects.has(`${USER}/stray`)).toBe(false);
    expect(server.objects.has(keptPath)).toBe(true);
    expect(server.objects.has(otherPath)).toBe(true);
    expect(server.objects.has(pendingPath)).toBe(true);
  });

  it('drops a candidate that is referenced again before the grace period ends', async () => {
    const path = await server.remoteFile(vault.key, 'flip', img('x'));
    clock += 2 * HOUR;
    await cleanup();
    expect(Object.keys((await getCleanupState(USER))!.candidates)).toEqual([path]);
    server.write({ kind: 'page', id: 'p', updatedAt: clock, deviceId: 'd', deleted: false, keyVersion: 1, payload: new Uint8Array([1]), files: [path] });
    clock += DAY;
    expect(await cleanup()).toMatchObject({ deleted: 0, candidates: 0 });
    expect(server.objects.has(path)).toBe(true);
  });

  it('keeps candidates when deleting fails and tries again next time', async () => {
    const path = await server.remoteFile(vault.key, 'gone', img('x'));
    clock += 2 * HOUR;
    await cleanup();
    clock += DAY;
    server.failRemove = true;
    await expect(cleanup()).rejects.toThrow();
    expect(server.objects.has(path)).toBe(true);
    server.failRemove = false;
    expect(await cleanup()).toMatchObject({ deleted: 1 });
  });

  it('uploads a fresh copy instead of re-referencing a file not confirmed recently', async () => {
    const docId = await createDocument('Doc', img('v1'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    await sync();
    const first = await getFileRef('page', page.id);
    expect(first!.confirmedAt).toBe(clock);

    // Within the window: an edit re-references the same object
    clock += REUSE_WINDOW_MS - 1;
    await savePageAnnotations(page.id, [{ id: 'a', type: 'rect', x: 0, y: 0, w: 0.5, h: 0.5, color: '#f00', width: 0.01 }]);
    await sync();
    expect((await getFileRef('page', page.id))!.fileId).toBe(first!.fileId);

    // The push confirmed it again; long after that, the next edit uploads afresh
    clock += REUSE_WINDOW_MS;
    await renameDocument(docId, 'x');
    await savePageAnnotations(page.id, []);
    const report = await sync();
    expect(report.uploads).toBe(1);
    expect((await getFileRef('page', page.id))!.fileId).not.toBe(first!.fileId);
  });
});

describe('remove synced documents from this device', () => {
  it('removes what has synced, keeps unsynced items, and leaves the server alone', async () => {
    const folderA = await createFolder('Synced folder');
    const folderB = await createFolder('Folder of an unsynced doc');
    const synced = await createDocument('Synced', img('a'));
    await db.documents.update(synced, { folderId: folderA });
    const later = await createDocument('Edited later', img('b'));
    await db.documents.update(later, { folderId: folderB });
    await sync();
    await sync();
    const serverRows = server.rows.size;

    await renameDocument(later, 'Edited after sync'); // pending in the outbox
    const unsynced = await createDocument('Never synced', img('c'));

    expect(await previewRemoval(USER)).toMatchObject({ synced: true, documents: [synced], keptDocuments: 2 });
    const plan = await removeSyncedFromDevice(USER);
    expect(plan).toMatchObject({ documents: [synced], folders: [folderA], keptDocuments: 2, keptFolders: 1 });

    expect(await db.documents.get(synced)).toBeUndefined();
    expect(await db.pages.where('documentId').equals(synced).count()).toBe(0);
    expect(await db.folders.get(folderA)).toBeUndefined();
    expect(await db.documents.get(later)).toBeDefined();
    expect(await db.documents.get(unsynced)).toBeDefined();
    expect(await db.folders.get(folderB)).toBeDefined();
    // Nothing queued for deletion, cursor reset
    expect((await readOutbox()).every((e) => e.op === 'upsert')).toBe(true);
    expect(await getCursor(USER)).toBe(0);

    // The next sync brings the removed document back and deletes nothing on the server
    clock += 1000;
    const report = await sync();
    expect(report.downloads).toBe(1);
    expect(server.rows.size).toBe(serverRows + 2); // the never-synced document and its page
    expect([...server.rows.values()].some((r) => r.deleted)).toBe(false);
    const back = await db.documents.get(synced);
    expect(back).toMatchObject({ name: 'Synced', folderId: folderA, pageCount: 1 });
    const [page] = await db.pages.where('documentId').equals(synced).toArray();
    expect(await page.processedBlob!.text()).toBe('a');
  });

  it('keeps a document whose page image has not been uploaded', async () => {
    const docId = await createDocument('Doc', img('a'));
    server.failUploads = 1;
    await sync();
    expect(await previewRemoval(USER)).toMatchObject({ documents: [], keptDocuments: 1 });
    await removeSyncedFromDevice(USER);
    expect(await db.documents.get(docId)).toBeDefined();
  });

  it('removes nothing before this device has synced with the account', async () => {
    const docId = await createDocument('Doc', img('a'));
    await sync();
    await sync();
    // Synced with another account last
    await db.syncMeta.put({ key: 'sync:lastUserId', value: 'someone-else' });
    const plan = await removeSyncedFromDevice(USER);
    expect(plan).toMatchObject({ synced: false, documents: [] });
    expect(await db.documents.get(docId)).toBeDefined();
  });
});
