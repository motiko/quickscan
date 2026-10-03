import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import { createDocument, deleteDocument, renameDocument, updatePage } from '@/hooks/useDocuments';
import { createFolder } from '@/lib/folders';
import { updateSettings } from '@/lib/settings';
import { getDeviceId, readOutbox } from '@/lib/outbox';
import { generateVaultKey, type VaultKey } from '@/lib/crypto';
import { createSupabaseBackend, type SupabaseLike } from '@/lib/sync/backend';
import { runSync } from '@/lib/sync/engine';
import { getFileRef, RetryTracker } from '@/lib/sync/state';
import { cleanupOrphanedFiles, ORPHAN_GRACE_MS } from '@/lib/sync/cleanup';

/*
 * Two simulated devices syncing through a real local Supabase: the upsert_records RPC, RLS,
 * the pull query and the vault Storage bucket. Each device is its own IndexedDB (a separate
 * fake-indexeddb factory swapped under the app's Dexie instance).
 *
 *   npx supabase start
 *   eval "$(npx supabase status -o env)"   # API_URL, PUBLISHABLE_KEY / ANON_KEY, SECRET_KEY / SERVICE_ROLE_KEY
 *   npm run test:supabase
 *
 * The secret key is the local stack's development key, read from the environment and used
 * only to create throwaway test users. Skipped when the variables aren't set.
 */

const URL = process.env.API_URL;
const PUBLISHABLE = process.env.PUBLISHABLE_KEY || process.env.ANON_KEY;
const SECRET = process.env.SECRET_KEY || process.env.SERVICE_ROLE_KEY;
const enabled = Boolean(URL && PUBLISHABLE && SECRET);
// CI sets this so a missing stack fails instead of skipping
if (process.env.REQUIRE_SUPABASE && !enabled) throw new Error('API_URL, PUBLISHABLE_KEY/ANON_KEY and SECRET_KEY/SERVICE_ROLE_KEY must be set');

interface Device {
  name: string;
  factory: IDBFactory;
}

const devices: Record<'phone' | 'laptop', Device> = {
  phone: { name: 'phone', factory: new IDBFactory() },
  laptop: { name: 'laptop', factory: new IDBFactory() },
};

async function use(device: Device) {
  db.close();
  (db as unknown as { _deps: { indexedDB: IDBFactory } })._deps.indexedDB = device.factory;
  await db.open();
}

let client: SupabaseClient;
let userId: string;
let vault: VaultKey;

async function sync() {
  return runSync({
    backend: createSupabaseBackend(client as unknown as SupabaseLike),
    userId,
    vault,
    deviceId: await getDeviceId(),
    now: () => Date.now(),
    retry: new RetryTracker(),
  });
}

describe.skipIf(!enabled)('sync through local Supabase', () => {
  beforeAll(async () => {
    const admin = createClient(URL!, SECRET!, { auth: { persistSession: false, autoRefreshToken: false } });
    const email = `sync-${crypto.randomUUID()}@example.test`;
    const password = crypto.randomUUID();
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (created.error) throw created.error;
    client = createClient(URL!, PUBLISHABLE!, { auth: { persistSession: false, autoRefreshToken: false } });
    const signedIn = await client.auth.signInWithPassword({ email, password });
    if (signedIn.error) throw signedIn.error;
    userId = signedIn.data.user!.id;
    vault = { key: await generateVaultKey(), keyVersion: 1 };
  });

  it('replicates records and images between two devices', async () => {
    await use(devices.phone);
    const folderId = await createFolder('Receipts');
    const docId = await createDocument('Hardware store', new Blob(['jpeg-bytes'], { type: 'image/jpeg' }));
    await db.documents.update(docId, { folderId, tags: ['diy'] });
    await updateSettings({ ocrLanguages: ['eng', 'fra'] });
    const phoneReport = await sync();
    expect(phoneReport.issues).toEqual([]);
    expect(phoneReport.uploads).toBe(1);
    expect(await readOutbox()).toEqual([]);

    // The server holds ciphertext only
    const { data: rows } = await client.from('records').select('kind,id,payload,files').eq('id', docId);
    expect(rows).toHaveLength(1);
    expect(String(rows![0].payload)).not.toContain(Buffer.from('Hardware').toString('hex'));

    await use(devices.laptop);
    const laptopReport = await sync();
    expect(laptopReport.issues).toEqual([]);
    expect(laptopReport.downloads).toBe(1);
    expect(await db.documents.get(docId)).toMatchObject({ name: 'Hardware store', folderId, tags: ['diy'], pageCount: 1 });
    expect(await db.folders.get(folderId)).toMatchObject({ name: 'Receipts' });
    expect((await db.settings.get('ocrLanguages'))?.value).toEqual(['eng', 'fra']);
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    expect(await page.processedBlob!.text()).toBe('jpeg-bytes');
    expect(page.originalBlob).toBeUndefined();
  });

  it('resolves concurrent edits by last write wins on both devices', async () => {
    await use(devices.laptop);
    const [doc] = await db.documents.toArray();
    await renameDocument(doc.id, 'Laptop name');
    await new Promise((r) => setTimeout(r, 20));
    await use(devices.phone);
    await renameDocument(doc.id, 'Phone name (later)');

    await use(devices.laptop);
    await sync();
    await use(devices.phone);
    const report = await sync();
    expect(report.rejected).toBe(0);
    expect((await db.documents.get(doc.id))!.name).toBe('Phone name (later)');
    await use(devices.laptop);
    await sync();
    expect((await db.documents.get(doc.id))!.name).toBe('Phone name (later)');
  });

  it('propagates deletions as tombstones', async () => {
    await use(devices.phone);
    const [doc] = await db.documents.toArray();
    await deleteDocument(doc.id);
    await sync();

    await use(devices.laptop);
    await sync();
    expect(await db.documents.get(doc.id)).toBeUndefined();
    expect(await db.pages.where('documentId').equals(doc.id).count()).toBe(0);
  });

  it('removes orphaned files from Storage after the grace period, never referenced ones', async () => {
    await use(devices.phone);
    const docId = await createDocument('Orphans', new Blob(['one'], { type: 'image/jpeg' }));
    await sync();
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    const firstPath = `${userId}/${(await getFileRef('page', page.id))!.fileId}`;
    await updatePage(page.id, { processedBlob: new Blob(['two'], { type: 'image/jpeg' }) });
    await sync();
    const currentPath = `${userId}/${(await getFileRef('page', page.id))!.fileId}`;
    expect(currentPath).not.toBe(firstPath);

    const backend = createSupabaseBackend(client as unknown as SupabaseLike);
    const objects = async () => {
      const { data, error } = await client.storage.from('vault').list(userId, { limit: 1000 });
      if (error) throw error;
      return data.map((o) => `${userId}/${o.name}`);
    };
    expect(await objects()).toContain(firstPath);

    // Storage's created_at is real time: pretend it's later on this device's clock
    const later = Date.now() + 2 * 60 * 60_000;
    expect(await cleanupOrphanedFiles(backend, userId, later, { force: true })).toMatchObject({ deleted: 0 });
    const second = await cleanupOrphanedFiles(backend, userId, later + ORPHAN_GRACE_MS, { force: true });
    // The replaced image, plus the image of the document deleted in the previous test
    expect(second.deleted).toBeGreaterThanOrEqual(1);

    const remaining = await objects();
    expect(remaining).not.toContain(firstPath);
    expect(remaining).toContain(currentPath);
    // Exactly what live records reference is left
    const { data: rows } = await client.from('records').select('files').eq('deleted', false);
    expect(remaining.sort()).toEqual(rows!.flatMap((r) => r.files as string[]).sort());

    // The other device still reads everything
    await use(devices.laptop);
    const report = await sync();
    expect(report.issues).toEqual([]);
    const [laptopPage] = await db.pages.where('documentId').equals(docId).toArray();
    expect(await laptopPage.processedBlob!.text()).toBe('two');
  });
});
