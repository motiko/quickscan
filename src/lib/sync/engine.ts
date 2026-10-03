import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import { ackOutbox, applyUntracked, readOutbox, SYNCED_SETTING_KEYS, type OutboxEntry, type SyncKind } from '@/lib/outbox';
import { decryptFile, decryptRecord, encryptFile, encryptRecord, type VaultKey } from '@/lib/crypto';
import type { Folder, Page, ScannedDocument, Signature } from '@/types';
import { SYNC_BATCH_SIZE, SyncBackendError, type PushRow, type RemoteRow, type SyncBackend } from './backend';
import {
  defined,
  documentPayload,
  folderPayload,
  isValidPayload,
  pagePayload,
  signaturePayload,
  type DocumentPayload,
  type FileRefPayload,
  type FolderPayload,
  type PagePayload,
  type RecordPayload,
  type SettingsPayload,
  type SignaturePayload,
} from './payload';
import {
  deleteFileRef,
  digestBlob,
  getCursor,
  getFileRef,
  getMeta,
  LAST_USER_KEY,
  listFileRefs,
  mergeKey,
  putFileRef,
  RetryTracker,
  cursorKey,
  fileKey,
  type FileRef,
} from './state';

/*
 * One sync run: account check → upload changed files → push the outbox → pull → normalise →
 * download missing files. No locking, scheduling or status here (see runner.ts); everything
 * the run touches outside IndexedDB comes in through `SyncContext`, so tests can pass a fake
 * server and clock.
 *
 * Rules:
 * - Dexie is the source of truth. Remote changes are written with `applyUntracked`, so they
 *   never re-enter the outbox and keep their remote clock.
 * - Last write wins per record by (updatedAt, deviceId); a tombstone is a write like any other.
 *   The server enforces it on push; on pull a pending local change that is at least as new as
 *   the remote row wins (it gets pushed next).
 * - Only ciphertext leaves the device: payloads via encryptRecord, files via encryptFile.
 */

export interface SyncContext {
  backend: SyncBackend;
  userId: string;
  vault: VaultKey;
  deviceId: string;
  /** Epoch ms; injectable for tests. */
  now: () => number;
  retry: RetryTracker;
  /** Thumbnail for a document's first page; omitted in tests (no canvas). */
  makeThumbnail?: (page: Page) => Promise<Blob>;
}

export type SyncStage = 'account' | 'upload' | 'push' | 'pull' | 'download';

export interface SyncIssue {
  stage: SyncStage;
  kind: SyncKind | string;
  id: string;
  message: string;
}

export interface SyncReport {
  /** True when this run was the first one with this account on this device (a merge). */
  merged: boolean;
  uploads: number;
  pushed: number;
  rejected: number;
  pulled: number;
  applied: number;
  /** Pulled rows a newer pending local change beat. */
  skipped: number;
  downloads: number;
  issues: SyncIssue[];
}

export class SyncError extends Error {
  constructor(
    readonly code: 'key-mismatch',
    message: string
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Compare two last-write-wins clocks; device ids compare bytewise like Postgres `collate "C"`. */
export function compareClock(aMs: number, aDevice: string, bMs: number, bDevice: string): number {
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  return aDevice < bDevice ? -1 : aDevice > bDevice ? 1 : 0;
}

const FILE_KINDS = new Set<SyncKind>(['page', 'signature']);

function isNetworkFailure(err: unknown): boolean {
  return err instanceof SyncBackendError && err.network;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function runSync(ctx: SyncContext): Promise<SyncReport> {
  const report: SyncReport = {
    merged: false,
    uploads: 0,
    pushed: 0,
    rejected: 0,
    pulled: 0,
    applied: 0,
    skipped: 0,
    downloads: 0,
    issues: [],
  };

  const merge = await prepareAccount(ctx.userId);
  report.merged = merge;
  if (merge) await checkVaultKey(ctx);

  await push(ctx, report);
  await pull(ctx, report, merge);
  // The merge is complete once one full pull has been applied
  if (merge) await db.syncMeta.delete(mergeKey(ctx.userId));
  await downloadFiles(ctx, report);
  return report;
}

// --- Account ------------------------------------------------------------------------------

/**
 * First sync with an account on this device (first ever, or after signing in to a different
 * account): forget everything known about the previous account's server state, and re-queue
 * every local record so the merge pushes all of it. Returns whether a merge is pending.
 *
 * - The cursor and file mappings belong to the old account: reset, so the new account's
 *   records are all pulled and every file is uploaded again under the new account.
 * - Pending upserts are kept (they're local edits; they now go to the new account).
 * - Pending tombstones are dropped: a merge deletes nothing on either side, and a delete
 *   made under one account must not remove a record another account happens to have.
 * - Records without a pending entry are queued with their own timestamp as the clock, so a
 *   copy that is newer on the server still wins; settings use the lowest clock, so an
 *   account's existing settings win over a newly joining device's.
 */
async function prepareAccount(userId: string): Promise<boolean> {
  const last = await getMeta<string>(LAST_USER_KEY);
  if (last !== userId) await startMerge(userId);
  return (await getMeta<boolean>(mergeKey(userId))) === true;
}

async function startMerge(userId: string): Promise<void> {
  await applyUntracked(async () => {
    await db.syncMeta.where('key').startsWith('sync:').delete();
    await db.outbox.filter((e) => e.op === 'delete').delete();

    const existing = new Map((await db.outbox.toArray()).map((e) => [`${e.kind}:${e.id}`, e]));
    const entries: OutboxEntry[] = [];
    const queue = (kind: SyncKind, id: string, clock: number, hasFile: boolean) => {
      const prev = existing.get(`${kind}:${id}`);
      entries.push(
        prev
          ? { ...prev, fileChanged: hasFile, rev: prev.rev + 1 }
          : { kind, id, op: 'upsert', updatedAt: clock, fileChanged: hasFile, rev: 1 }
      );
    };
    const time = (d: Date | undefined, fallback: number) => (d instanceof Date ? d.getTime() : fallback);

    await db.documents.each((d) => queue('document', d.id, time(d.updatedAt, 1), false));
    await db.pages.each((p) =>
      queue('page', p.id, time(p.updatedAt, time(p.createdAt, 1)), p.processedBlob != null)
    );
    await db.folders.each((f) => queue('folder', f.id, time(f.updatedAt, time(f.createdAt, 1)), false));
    await db.signatures.each((s) => queue('signature', s.id, time(s.createdAt, 1), true));
    const settings = await db.settings.bulkGet([...SYNCED_SETTING_KEYS]);
    for (const row of settings) if (row) queue('settings', row.key, 1, false);

    await db.outbox.bulkPut(entries);
    await db.syncMeta.put({ key: LAST_USER_KEY, value: userId });
    await db.syncMeta.put({ key: mergeKey(userId), value: true });
  });
}

/**
 * Before merging into an account, make sure this device's vault key can read it: pushing
 * records encrypted with a different key would make them unreadable on every other device.
 */
async function checkVaultKey(ctx: SyncContext): Promise<void> {
  const rows = await ctx.backend.pullRecords(ctx.userId, 0, 20);
  const live = rows.filter((r) => !r.deleted && r.payload);
  if (live.length === 0) return;
  for (const row of live) {
    try {
      await decryptRecord(ctx.vault.key, { userId: ctx.userId, kind: row.kind, id: row.id }, row.payload!);
      return;
    } catch {
      // try the next one; a single damaged row isn't a key mismatch
    }
  }
  throw new SyncError(
    'key-mismatch',
    'This device’s encryption key doesn’t match your account. Unlock sync again in Settings.'
  );
}

// --- Push ---------------------------------------------------------------------------------

async function push(ctx: SyncContext, report: SyncReport): Promise<void> {
  const entries = await readOutbox();
  for (let i = 0; i < entries.length; i += SYNC_BATCH_SIZE) {
    const rows: PushRow[] = [];
    const sent: OutboxEntry[] = [];
    for (const entry of entries.slice(i, i + SYNC_BATCH_SIZE)) {
      const key = `push:${entry.kind}:${entry.id}`;
      if (!ctx.retry.ready(key, ctx.now())) continue;
      try {
        rows.push(await buildRow(ctx, entry, report));
        sent.push(entry);
        ctx.retry.succeeded(key);
      } catch (err) {
        if (isNetworkFailure(err)) throw err;
        ctx.retry.failed(key, ctx.now());
        report.issues.push({ stage: 'upload', kind: entry.kind, id: entry.id, message: message(err) });
      }
    }
    if (rows.length === 0) continue;
    const rejected = await ctx.backend.upsertRecords(rows);
    report.pushed += rows.length - rejected.length;
    report.rejected += rejected.length;
    // Rejected rows are acknowledged too: the server keeps its newer version and the pull
    // below brings it here.
    await ackOutbox(sent);
  }
}

async function buildRow(ctx: SyncContext, entry: OutboxEntry, report: SyncReport): Promise<PushRow> {
  const base = {
    kind: entry.kind,
    id: entry.id,
    updatedAt: entry.updatedAt,
    deviceId: ctx.deviceId,
    keyVersion: ctx.vault.keyVersion,
  };
  const tombstone: PushRow = { ...base, deleted: true, payload: null, files: [] };
  if (entry.op === 'delete') {
    if (FILE_KINDS.has(entry.kind)) await deleteFileRef(entry.kind as FileRef['kind'], entry.id);
    return tombstone;
  }
  const built = await localPayload(ctx, entry, report);
  // Gone since it was queued (removed by a pulled tombstone): push the deletion
  if (!built) return tombstone;
  const payload = await encryptRecord(ctx.vault.key, { userId: ctx.userId, kind: entry.kind, id: entry.id }, built.payload);
  return { ...base, deleted: false, payload, files: built.files };
}

async function localPayload(
  ctx: SyncContext,
  entry: OutboxEntry,
  report: SyncReport
): Promise<{ payload: RecordPayload; files: string[] } | null> {
  const plain = (payload: RecordPayload) => ({ payload, files: [] });
  switch (entry.kind) {
    case 'document': {
      const doc = await db.documents.get(entry.id);
      return doc ? plain(documentPayload(doc)) : null;
    }
    case 'folder': {
      const folder = await db.folders.get(entry.id);
      return folder ? plain(folderPayload(folder)) : null;
    }
    case 'settings': {
      const row = await db.settings.get(entry.id);
      return row && SYNCED_SETTING_KEYS.includes(row.key) ? plain({ value: row.value } satisfies SettingsPayload) : null;
    }
    case 'page': {
      const page = await db.pages.get(entry.id);
      if (!page) return null;
      const ref = await syncFile(ctx, 'page', entry.id, page.processedBlob, entry.fileChanged, report);
      return { payload: pagePayload(page, fileRefPayload(ref)), files: ref ? [filePath(ref)] : [] };
    }
    case 'signature': {
      const sig = await db.signatures.get(entry.id);
      if (!sig) return null;
      const ref = await syncFile(ctx, 'signature', entry.id, sig.blob, entry.fileChanged, report);
      return { payload: signaturePayload(sig, fileRefPayload(ref)), files: ref ? [filePath(ref)] : [] };
    }
    default:
      return null;
  }
}

const filePath = (ref: Pick<FileRef, 'userId' | 'fileId'>) => `${ref.userId}/${ref.fileId}`;
const fileRefPayload = (ref: FileRef | undefined): FileRefPayload | undefined =>
  ref && { id: ref.fileId, type: ref.type };

/**
 * The remote file a record should reference, uploading the local blob first when it's new.
 * A file is uploaded once per change: unchanged blobs (same SHA-256 as the last upload or
 * download) reuse the existing object, even if the record is pushed again.
 */
async function syncFile(
  ctx: SyncContext,
  kind: FileRef['kind'],
  id: string,
  blob: Blob | undefined,
  changed: boolean,
  report: SyncReport
): Promise<FileRef | undefined> {
  const stored = await getFileRef(kind, id);
  const current = stored?.userId === ctx.userId ? stored : undefined;
  // No local bytes: either nothing to sync or a pulled file that hasn't downloaded yet
  if (!blob) return current;
  if (current && !changed) return current;

  const sha256 = await digestBlob(blob);
  if (current?.sha256 === sha256) return current;

  const fileId = nanoid();
  const type = blob.type || (kind === 'signature' ? 'image/png' : 'image/jpeg');
  const sealed = await encryptFile(ctx.vault.key, { userId: ctx.userId, fileId }, blob);
  await ctx.backend.uploadFile(filePath({ userId: ctx.userId, fileId }), sealed);
  const ref: FileRef = { kind, id, userId: ctx.userId, fileId, type, sha256, downloaded: true };
  await putFileRef(ref);
  report.uploads++;
  return ref;
}

// --- Pull ---------------------------------------------------------------------------------

interface Decoded {
  row: RemoteRow;
  value?: RecordPayload;
}

interface Touched {
  documents: Set<string>;
  pages: Set<string>;
}

async function pull(ctx: SyncContext, report: SyncReport, merge: boolean): Promise<void> {
  const touched: Touched = { documents: new Set(), pages: new Set() };
  let cursor = await getCursor(ctx.userId);

  for (;;) {
    const rows = await ctx.backend.pullRecords(ctx.userId, cursor, SYNC_BATCH_SIZE);
    if (rows.length === 0) break;
    report.pulled += rows.length;

    // Decrypt first: a transaction can't wait on WebCrypto without committing early
    const decoded: Decoded[] = [];
    for (const row of rows) {
      if (row.deleted) {
        decoded.push({ row });
        continue;
      }
      try {
        if (!row.payload) throw new Error('Missing payload');
        const value = await decryptRecord(ctx.vault.key, { userId: ctx.userId, kind: row.kind, id: row.id }, row.payload);
        if (!isValidPayload(row.kind, value)) throw new Error(`Unsupported ${row.kind} payload`);
        decoded.push({ row, value });
      } catch (err) {
        // Recorded and skipped; the cursor still moves past it so one bad row can't stall sync
        report.issues.push({ stage: 'pull', kind: row.kind, id: row.id, message: message(err) });
      }
    }

    const lastSeq = rows[rows.length - 1].seq;
    await applyBatch(ctx, decoded, merge, touched, report, lastSeq);
    cursor = lastSeq;
    if (rows.length < SYNC_BATCH_SIZE) break;
  }

  await normalizeDocuments(ctx, touched);
}

/** Pending changes to one table during a batch: id -> new value, or null for a delete. */
class Working<T> {
  private values = new Map<string, T | null>();
  private dirty = new Set<string>();

  load(entries: [string, T | undefined][]) {
    for (const [id, value] of entries) if (value !== undefined && !this.values.has(id)) this.values.set(id, value);
  }
  get(id: string): T | undefined {
    return this.values.get(id) ?? undefined;
  }
  set(id: string, value: T) {
    this.values.set(id, value);
    this.dirty.add(id);
  }
  delete(id: string) {
    this.values.set(id, null);
    this.dirty.add(id);
  }
  all(): T[] {
    return [...this.values.values()].filter((v): v is T => v != null);
  }
  puts(): T[] {
    return [...this.dirty].map((id) => this.values.get(id)).filter((v): v is T => v != null);
  }
  deletes(): string[] {
    return [...this.dirty].filter((id) => this.values.get(id) === null);
  }
}

interface BatchState {
  documents: Working<ScannedDocument>;
  pages: Working<Page>;
  folders: Working<Folder>;
  signatures: Working<Signature>;
  settings: Working<{ key: string; value: unknown }>;
  /** File refs by syncMeta key. */
  refs: Working<FileRef>;
  outbox: OutboxEntry[];
}

/**
 * Apply one pulled batch in one untracked transaction: read what the rows touch, work out the
 * result in memory, write it, save the cursor. Only direct Dexie calls inside the transaction:
 * awaiting nested native async helpers can drop Dexie's transaction zone and commit it early.
 */
async function applyBatch(
  ctx: SyncContext,
  decoded: Decoded[],
  merge: boolean,
  touched: Touched,
  report: SyncReport,
  lastSeq: number
): Promise<void> {
  const idsOf = (kind: SyncKind) => decoded.filter((d) => d.row.kind === kind).map((d) => d.row.id);
  const docIds = idsOf('document');
  const pageIds = idsOf('page');
  const folderIds = idsOf('folder');
  const signatureIds = idsOf('signature');
  const settingKeys = idsOf('settings');
  const deletedDocIds = decoded.filter((d) => d.row.kind === 'document' && d.row.deleted).map((d) => d.row.id);
  const pair = <T,>(ids: string[], values: (T | undefined)[]) => ids.map((id, i) => [id, values[i]] as [string, T | undefined]);
  const refValue = (row: { value: unknown } | undefined) => row?.value as FileRef | undefined;

  await applyUntracked(async () => {
    const pending = await db.outbox.bulkGet(decoded.map((d) => [d.row.kind, d.row.id] as [SyncKind, string]));
    const state: BatchState = {
      documents: new Working(),
      pages: new Working(),
      folders: new Working(),
      signatures: new Working(),
      settings: new Working(),
      refs: new Working(),
      outbox: [],
    };
    state.documents.load(pair(docIds, await db.documents.bulkGet(docIds)));
    state.pages.load(pair(pageIds, await db.pages.bulkGet(pageIds)));
    const cascade = deletedDocIds.length > 0 ? await db.pages.where('documentId').anyOf(deletedDocIds).toArray() : [];
    state.pages.load(cascade.map((p) => [p.id, p]));
    state.folders.load(pair(folderIds, await db.folders.bulkGet(folderIds)));
    state.signatures.load(pair(signatureIds, await db.signatures.bulkGet(signatureIds)));
    state.settings.load(pair(settingKeys, await db.settings.bulkGet(settingKeys)));
    const refKeys = [
      ...[...pageIds, ...cascade.map((p) => p.id)].map((id) => fileKey('page', id)),
      ...signatureIds.map((id) => fileKey('signature', id)),
    ];
    state.refs.load(pair(refKeys, (await db.syncMeta.bulkGet(refKeys)).map(refValue)));

    decoded.forEach((item, i) => applyRow(ctx, item, pending[i], merge, state, touched, report));

    await db.documents.bulkPut(state.documents.puts());
    await db.documents.bulkDelete(state.documents.deletes());
    await db.pages.bulkPut(state.pages.puts());
    await db.pages.bulkDelete(state.pages.deletes());
    await db.folders.bulkPut(state.folders.puts());
    await db.folders.bulkDelete(state.folders.deletes());
    await db.signatures.bulkPut(state.signatures.puts());
    await db.signatures.bulkDelete(state.signatures.deletes());
    await db.settings.bulkPut(state.settings.puts());
    await db.settings.bulkDelete(state.settings.deletes());
    await db.syncMeta.bulkPut(state.refs.puts().map((ref) => ({ key: fileKey(ref.kind, ref.id), value: ref })));
    await db.syncMeta.bulkDelete(state.refs.deletes());
    await db.outbox.bulkPut(state.outbox);
    await db.syncMeta.put({ key: cursorKey(ctx.userId), value: lastSeq });
  });
}

/** Last-write-wins for one pulled row against this device's pending change. Synchronous. */
function applyRow(
  ctx: SyncContext,
  { row, value }: Decoded,
  pending: OutboxEntry | undefined,
  merge: boolean,
  state: BatchState,
  touched: Touched,
  report: SyncReport
) {
  if (pending && compareClock(pending.updatedAt, ctx.deviceId, row.updatedAt, row.deviceId) >= 0) {
    report.skipped++;
    return;
  }
  if (row.deleted) {
    applyTombstone(ctx, row, merge, state, touched, pending);
  } else if (value) {
    applyUpsert(ctx, row, value, state, touched);
  }
  report.applied++;
}

function applyUpsert(ctx: SyncContext, row: RemoteRow, value: RecordPayload, state: BatchState, touched: Touched) {
  const { id } = row;
  switch (row.kind) {
    case 'document': {
      const p = value as DocumentPayload;
      const existing = state.documents.get(id);
      state.documents.set(
        id,
        defined({
          id,
          name: p.name,
          nameSource: p.nameSource,
          folderId: p.folderId,
          tags: p.tags,
          summary: p.summary,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          // Local-only and derived fields stay; derived ones are recomputed after the pull
          pageCount: existing?.pageCount ?? 0,
          searchText: existing?.searchText,
          thumbnailBlob: existing?.thumbnailBlob,
        })
      );
      touched.documents.add(id);
      return;
    }
    case 'page': {
      const p = value as PagePayload;
      const existing = state.pages.get(id);
      trackRemoteFile(ctx, state, 'page', id, p.file);
      const hasOcr = p.ocrText !== undefined || p.ocrInfo !== undefined;
      state.pages.set(
        id,
        defined({
          id,
          documentId: p.documentId,
          pageNumber: p.pageNumber,
          corners: p.corners,
          filter: p.filter,
          rotation: p.rotation,
          ocrText: p.ocrText,
          ocrWords: p.ocrWords,
          ocrLang: p.ocrLang,
          ocrInfo: p.ocrInfo,
          annotations: p.annotations,
          createdAt: p.createdAt,
          updatedAt: new Date(row.updatedAt),
          // The original never syncs; it exists only on the device that captured the page.
          // Until a changed image downloads, the previous one keeps showing.
          originalBlob: existing?.originalBlob,
          processedBlob: existing?.processedBlob,
          // Pulled text is final; without any, leave local recognition as it was (the device
          // that has the image recognizes it and syncs the text)
          ocrStatus: hasOcr ? 'done' : existing?.ocrStatus === 'done' ? undefined : existing?.ocrStatus,
        })
      );
      if (existing && existing.documentId !== p.documentId) touched.documents.add(existing.documentId);
      touched.documents.add(p.documentId);
      touched.pages.add(id);
      return;
    }
    case 'folder': {
      const p = value as FolderPayload;
      state.folders.set(id, { id, name: p.name, createdAt: p.createdAt, updatedAt: new Date(row.updatedAt) });
      return;
    }
    case 'signature': {
      const p = value as SignaturePayload;
      const meta = { width: p.width, height: p.height, createdAt: p.createdAt };
      const existing = state.signatures.get(id);
      if (existing) state.signatures.set(id, { ...existing, ...meta });
      // A signature can't exist without its image: a new one waits in its file ref
      trackRemoteFile(ctx, state, 'signature', id, p.file, existing ? undefined : meta);
      return;
    }
    case 'settings': {
      if (!SYNCED_SETTING_KEYS.includes(id)) return;
      state.settings.set(id, { key: id, value: (value as SettingsPayload).value });
      return;
    }
  }
}

/** Point the record's file ref at the pulled file; a new file id means a download is due. */
function trackRemoteFile(
  ctx: SyncContext,
  state: BatchState,
  kind: FileRef['kind'],
  id: string,
  file: FileRefPayload | undefined,
  pendingSignature?: FileRef['pendingSignature']
) {
  const key = fileKey(kind, id);
  const ref = state.refs.get(key);
  if (!file) {
    if (ref) state.refs.delete(key);
    return;
  }
  if (ref && ref.userId === ctx.userId && ref.fileId === file.id) {
    if (pendingSignature && !ref.downloaded) state.refs.set(key, { ...ref, pendingSignature });
    return;
  }
  state.refs.set(
    key,
    defined({ kind, id, userId: ctx.userId, fileId: file.id, type: file.type, downloaded: false, pendingSignature })
  );
}

function localRecord(state: BatchState, kind: SyncKind, id: string): unknown {
  switch (kind) {
    case 'document':
      return state.documents.get(id);
    case 'page':
      return state.pages.get(id);
    case 'folder':
      return state.folders.get(id);
    case 'signature':
      return state.signatures.get(id);
    case 'settings':
      return state.settings.get(id);
    default:
      return undefined;
  }
}

function dropRef(state: BatchState, kind: FileRef['kind'], id: string) {
  const key = fileKey(kind, id);
  if (state.refs.get(key)) state.refs.delete(key);
}

function applyTombstone(
  ctx: SyncContext,
  row: RemoteRow,
  merge: boolean,
  state: BatchState,
  touched: Touched,
  pending: OutboxEntry | undefined
) {
  const { kind, id } = row;
  if (merge && localRecord(state, kind, id) !== undefined) {
    // First sync with this account deletes nothing: keep the local record and queue it with
    // a clock newer than the tombstone, which brings it back on the server too.
    const hasFile = kind === 'page' ? state.pages.get(id)?.processedBlob != null : kind === 'signature';
    state.outbox.push({
      kind,
      id,
      op: 'upsert',
      updatedAt: Math.max(ctx.now(), row.updatedAt + 1),
      fileChanged: hasFile,
      rev: (pending?.rev ?? 0) + 1,
    });
    return;
  }

  switch (kind) {
    case 'document': {
      // Cascade like deleteDocument: the document's pages go with it
      state.documents.delete(id);
      for (const page of state.pages.all().filter((p) => p.documentId === id)) {
        state.pages.delete(page.id);
        dropRef(state, 'page', page.id);
      }
      return;
    }
    case 'page': {
      const page = state.pages.get(id);
      state.pages.delete(id);
      dropRef(state, 'page', id);
      if (page) touched.documents.add(page.documentId);
      return;
    }
    case 'folder':
      // Documents still pointing at it count as unfiled; the deleting device unfiles them too
      state.folders.delete(id);
      return;
    case 'signature':
      state.signatures.delete(id);
      dropRef(state, 'signature', id);
      return;
    case 'settings':
      if (SYNCED_SETTING_KEYS.includes(id)) state.settings.delete(id);
      return;
  }
}

/**
 * After a pull: renumber each touched document's pages 1..n in (pageNumber, id) order — two
 * devices adding a page at once both pick the same number — and recompute the derived fields
 * (pageCount, searchText). Local only (untracked); the thumbnail follows the first page.
 */
async function normalizeDocuments(ctx: SyncContext, touched: Touched): Promise<void> {
  if (touched.documents.size === 0) return;
  const thumbnails: Page[] = [];
  await applyUntracked(async () => {
    for (const docId of touched.documents) {
      const doc = await db.documents.get(docId);
      if (!doc) continue;
      const pages = await db.pages.where('documentId').equals(docId).toArray();
      pages.sort((a, b) => a.pageNumber - b.pageNumber || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].pageNumber !== i + 1) {
          pages[i] = { ...pages[i], pageNumber: i + 1 };
          await db.pages.update(pages[i].id, { pageNumber: i + 1 });
        }
      }
      const searchText = pages
        .map((p) => p.ocrText ?? '')
        .filter(Boolean)
        .join('\n')
        .toLowerCase();
      if (doc.pageCount !== pages.length || (doc.searchText ?? '') !== searchText) {
        await db.documents.update(docId, { pageCount: pages.length, searchText });
      }
      const first = pages[0];
      if (first && (first.processedBlob || first.originalBlob) && (!doc.thumbnailBlob || touched.pages.has(first.id))) {
        thumbnails.push(first);
      }
    }
  });
  for (const page of thumbnails) await refreshThumbnail(ctx, page);
}

async function refreshThumbnail(ctx: SyncContext, page: Page): Promise<void> {
  if (!ctx.makeThumbnail) return;
  try {
    const thumbnailBlob = await ctx.makeThumbnail(page);
    await applyUntracked(() => db.documents.update(page.documentId, { thumbnailBlob }));
  } catch (err) {
    console.warn('Sync: could not rebuild a thumbnail', err);
  }
}

// --- Files --------------------------------------------------------------------------------

/**
 * Download every pulled file this device doesn't have yet (page images, signature PNGs),
 * decrypt and store it. Failures back off per file and never fail the run.
 */
async function downloadFiles(ctx: SyncContext, report: SyncReport): Promise<void> {
  const due = (await listFileRefs()).filter((r) => !r.downloaded && r.userId === ctx.userId);
  for (const ref of due) {
    const key = `download:${ref.kind}:${ref.id}:${ref.fileId}`;
    if (!ctx.retry.ready(key, ctx.now())) continue;
    try {
      const sealed = await ctx.backend.downloadFile(filePath(ref));
      const blob = await decryptFile(ctx.vault.key, { userId: ref.userId, fileId: ref.fileId }, sealed, { type: ref.type });
      const sha256 = await digestBlob(blob);
      const page = await applyUntracked(() => storeDownloadedFile(ref, blob, sha256));
      ctx.retry.succeeded(key);
      report.downloads++;
      if (page) {
        const pages = await db.pages.where('documentId').equals(page.documentId).sortBy('pageNumber');
        if (pages[0]?.id === page.id) await refreshThumbnail(ctx, pages[0]);
      }
    } catch (err) {
      if (isNetworkFailure(err)) throw err;
      ctx.retry.failed(key, ctx.now());
      report.issues.push({ stage: 'download', kind: ref.kind, id: ref.id, message: message(err) });
    }
  }
}

/**
 * Runs inside applyUntracked. Returns the page that got its image, if any. Direct Dexie calls
 * only (see applyBatch).
 */
async function storeDownloadedFile(ref: FileRef, blob: Blob, sha256: string): Promise<Page | null> {
  const key = fileKey(ref.kind, ref.id);
  const current = (await db.syncMeta.get(key))?.value as FileRef | undefined;
  // Replaced or removed while downloading: the newer ref gets its own download
  if (!current || current.fileId !== ref.fileId || current.userId !== ref.userId) return null;
  const done: FileRef = { ...current, downloaded: true, sha256 };
  delete done.pendingSignature;

  if (ref.kind === 'page') {
    const page = await db.pages.get(ref.id);
    if (!page) {
      await db.syncMeta.delete(key);
      return null;
    }
    await db.pages.update(ref.id, { processedBlob: blob });
    await db.syncMeta.put({ key, value: done });
    return { ...page, processedBlob: blob };
  }

  const existing = await db.signatures.get(ref.id);
  if (existing) {
    await db.signatures.update(ref.id, { blob });
  } else if (current.pendingSignature) {
    const sig: Signature = { id: ref.id, blob, ...current.pendingSignature };
    await db.signatures.add(sig);
  } else {
    await db.syncMeta.delete(key);
    return null;
  }
  await db.syncMeta.put({ key, value: done });
  return null;
}

