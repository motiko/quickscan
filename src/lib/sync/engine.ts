import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import { ackOutbox, applyUntracked, readOutbox, SYNCED_SETTING_KEYS, type OutboxEntry, type SyncKind } from '@/lib/outbox';
import { decryptFile, encryptFile, encryptRecord, openRecord, type VaultKey } from '@/lib/crypto';
import type { Folder, Page, ScannedDocument, Signature } from '@/types';
import { SYNC_BATCH_SIZE, SyncBackendError, type PushRow, type RejectedRow, type RemoteRow, type SyncBackend } from './backend';
import {
  defined,
  documentPayload,
  folderPayload,
  isValidPayload,
  materialHash,
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
import { cleanupOrphanedFiles, REUSE_WINDOW_MS, type CleanupResult } from './cleanup';
import {
  ACCOUNT_SWITCH_KEY,
  badRowsKey,
  deleteFileRef,
  digestBlob,
  getCursor,
  getFileRef,
  getMeta,
  LAST_USER_KEY,
  listFileRefs,
  markKey,
  marksReadyKey,
  mergeKey,
  putFileRef,
  RetryTracker,
  cursorKey,
  fileKey,
  type AccountSwitchDecision,
  type BadRow,
  type FileRef,
  type RecordMark,
} from './state';

/*
 * One sync run: account check → pull → upload changed files and push the outbox → (pull again
 * if a push lost) → normalise → download missing files. No locking, scheduling or status here
 * (see runner.ts); everything the run touches outside IndexedDB comes in through
 * `SyncContext`, so tests can pass a fake server and clock.
 *
 * Rules:
 * - Dexie is the source of truth. Remote changes are written with `applyUntracked`, so they
 *   never re-enter the outbox and keep their remote clock.
 * - Last write wins per record by (updatedAt, deviceId); a tombstone is a write like any other.
 *   The server enforces it on push; on pull a pending local change that is at least as new as
 *   the remote row wins (it gets pushed next). Local clocks are hybrid: a write is clocked at
 *   least 1 ms past the newest version of the record this device has seen (`writeClock` in
 *   sync-tracking.ts), so an edit made after seeing a version always beats it.
 * - Pull first, then push: a remote version that arrives while a local change of the same
 *   record is pending is a concurrent edit, and is settled here before either overwrites the
 *   other. A push that still loses (someone wrote in between) stays queued, and a second pull
 *   settles it the same way.
 * - Conflicted copies: when two devices changed the same page concurrently and the losing
 *   version changed something that matters (`materialHash`: annotations, crop, filter,
 *   rotation, cloud-model text) and differs from the winner, the loser is kept as a new page
 *   right after the original, with `conflictOf` set. Whichever device sees the conflict keeps
 *   it — the loser may be its own pending edit or the remote version — and syncs the copy like
 *   any new page, so every device ends up with the same pages. Documents, folders, signatures
 *   and settings stay plain last-write-wins. A delete never gets a copy.
 * - Replays: each record's marker remembers the newest version pulled (`RecordMark`); a pulled
 *   row older than that, or a v1 payload after a v2 one, is rejected and reported as unreadable.
 *   v2 payloads authenticate the clock the writer sent; the row clock may be lower (the server
 *   clamps clocks to now + 5 minutes) but never higher.
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
  /** Pull again the rows that couldn't be read last time (the user pressed Retry). */
  retryBadRows?: boolean;
  /** Run the orphaned-file cleanup even if it ran within the last day. */
  forceCleanup?: boolean;
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
  /** Pulled files this device still has to download. */
  pendingDownloads: number;
  /** The orphaned-file cleanup, when it ran without error. */
  cleanup?: CleanupResult;
  /** Concurrent edits settled in this run (see the rules above). */
  conflicts: SyncConflict[];
  /** Pulled rows rejected as replays of older versions. */
  replayed: number;
  /**
   * Set when nothing was synced because another account's documents are on this device and
   * the user hasn't said whether to upload them (see account-switch.ts).
   */
  accountSwitch?: AccountSwitchPending;
  issues: SyncIssue[];
}

/**
 * A concurrent edit this device settled. Pages get a conflicted copy (`copyId`) when the
 * losing version is worth keeping; for other kinds the newer version simply won.
 */
export interface SyncConflict {
  kind: SyncKind;
  id: string;
  /** The conflicted copy that keeps the losing version of a page. */
  copyId?: string;
  /** Whose version lost: this device's pending edit, or the pulled one. */
  loser: 'local' | 'remote';
}

export interface AccountSwitchPending {
  /** The account this device's data was last synced with. */
  previousUserId: string;
  documents: number;
  folders: number;
  signatures: number;
  /** The user already removed what was synced with the previous account; these are left. */
  removed: boolean;
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
    pendingDownloads: 0,
    conflicts: [],
    replayed: 0,
    issues: [],
  };

  const account = await prepareAccount(ctx.userId);
  if (account.pending) {
    // Nothing leaves the device until the user decides (Settings / the sync indicator)
    report.accountSwitch = account.pending;
    return report;
  }
  const merge = account.merge;
  report.merged = merge;
  if (merge) await checkVaultKey(ctx);
  else await initMarks(ctx.userId);

  await pull(ctx, report, merge);
  const lost = await push(ctx, report);
  if (lost.length > 0) {
    // Someone wrote these between our pull and push: bring their versions here, which settles
    // each conflict (and may queue conflicted copies, pushed right away)
    const copies = report.conflicts.length;
    await pull(ctx, report, merge);
    // Anything still pending as pushed lost to a version this device can't read: give up on it
    await ackOutbox(lost);
    if (report.conflicts.length > copies) await push(ctx, report);
  }
  // The merge is complete once one full pull has been applied
  if (merge) await db.syncMeta.delete(mergeKey(ctx.userId));
  await downloadFiles(ctx, report);
  // Only after a successful push and pull (both throw otherwise), and not during a merge,
  // which re-uploads everything
  if (!merge) {
    try {
      report.cleanup = await cleanupOrphanedFiles(ctx.backend, ctx.userId, ctx.now(), { force: ctx.forceCleanup });
    } catch (err) {
      // Best effort: tried again next run
      console.warn('Sync: orphaned file cleanup failed', err);
    }
  }
  report.pendingDownloads = (await listFileRefs()).filter((r) => !r.downloaded && r.userId === ctx.userId).length;
  return report;
}

// --- Account ------------------------------------------------------------------------------

/**
 * Whether this run may sync, and whether it's a merge (the first sync with this account on
 * this device).
 *
 * - First sync ever on this device: merge, without asking.
 * - Same account as last time: carry on.
 * - A different account than last time, with documents, folders or signatures on the device:
 *   they came from (or were made under) the other account, so nothing is uploaded until the
 *   user chooses (`accountSwitchPending`): upload them to this account (a merge), or remove
 *   what's synced with the other account first (account-switch.ts).
 */
async function prepareAccount(userId: string): Promise<{ merge: boolean; pending?: AccountSwitchPending }> {
  const last = await getMeta<string>(LAST_USER_KEY);
  if (last !== userId) {
    if (last) {
      const pending = await accountSwitchPending(last, userId);
      if (pending) return { merge: false, pending };
    }
    await startMerge(userId);
  }
  return { merge: (await getMeta<boolean>(mergeKey(userId))) === true };
}

/**
 * Null when `userId` may take over this device's data from `previousUserId`: the user chose to
 * upload it, or there's nothing left to upload. Otherwise what's waiting for the choice.
 */
export async function accountSwitchPending(previousUserId: string, userId: string): Promise<AccountSwitchPending | null> {
  const decision = await getMeta<AccountSwitchDecision>(ACCOUNT_SWITCH_KEY);
  const current = decision?.from === previousUserId && decision.to === userId ? decision : undefined;
  if (current?.choice === 'merge') return null;
  const documents = await db.documents.count();
  const folders = await db.folders.count();
  const signatures = await db.signatures.count();
  if (documents + folders + signatures === 0) return null;
  return { previousUserId, documents, folders, signatures, removed: current?.choice === 'remove' };
}

/**
 * Base markers for pages synced before markers existed: a page with no pending change is the
 * version this device last synced, so its fingerprint is the base. Once per account.
 */
async function initMarks(userId: string): Promise<void> {
  if (await getMeta<boolean>(marksReadyKey(userId))) return;
  await applyUntracked(async () => {
    const pending = new Set((await db.outbox.toArray()).filter((e) => e.kind === 'page').map((e) => e.id));
    const marks = new Set((await db.syncMeta.where('key').startsWith(markKey('page', '')).primaryKeys()) as string[]);
    const puts: { key: string; value: RecordMark }[] = [];
    await db.pages.each((page) => {
      const key = markKey('page', page.id);
      if (pending.has(page.id) || marks.has(key)) return;
      puts.push({ key, value: { clock: 0, device: '', hash: materialHash(page) } });
    });
    await db.syncMeta.bulkPut(puts);
    await db.syncMeta.put({ key: marksReadyKey(userId), value: true });
  });
}

/**
 * First sync with an account on this device (first ever, or after signing in to a different
 * account): forget everything known about the previous account's server state, and re-queue
 * every local record so the merge pushes all of it.
 *
 * - The cursor and file mappings belong to the old account: reset, so the new account's
 *   records are all pulled and every file is uploaded again under the new account.
 * - Pending upserts are kept (they're local edits; they now go to the new account).
 * - Pending tombstones are dropped: a merge deletes nothing on either side, and a delete
 *   made under one account must not remove a record another account happens to have.
 * - Records without a pending entry are queued with their own timestamp as the clock, so a
 *   copy that is newer on the server still wins; settings use the lowest clock, so an
 *   account's existing settings win over a newly joining device's.
 * - Record markers go too (they describe the old account's versions), as does the answer to
 *   the account-switch question, which this merge carries out.
 */
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
      await openRecord(ctx.vault.key, { userId: ctx.userId, kind: row.kind, id: row.id }, row.payload!, {
        deviceId: row.deviceId,
        deleted: false,
      });
      return;
    } catch {
      // try the next one; a single damaged row isn't a key mismatch
    }
  }
  throw new SyncError(
    'key-mismatch',
    'This device’s encryption key doesn’t match your account. Unlock sync again with your recovery key.'
  );
}

// --- Push ---------------------------------------------------------------------------------

/**
 * Push the outbox. Accepted entries are acknowledged and become the records' base. Returns
 * the entries the server rejected because it holds a newer version this device hasn't seen:
 * they stay queued for the follow-up pull to settle. A rejection by a version this device
 * had already seen when the edit was made (possible only when the clock cap held the write
 * clock back) is re-queued just past that version, so the edit wins next time.
 */
async function push(ctx: SyncContext, report: SyncReport): Promise<OutboxEntry[]> {
  const entries = await readOutbox();
  const lost: OutboxEntry[] = [];
  ctx.retry.retain('push:', new Set(entries.map((e) => `push:${e.kind}:${e.id}`)));
  for (let i = 0; i < entries.length; i += SYNC_BATCH_SIZE) {
    const rows: PushRow[] = [];
    const sent: OutboxEntry[] = [];
    const hashes = new Map<string, string | undefined>();
    for (const entry of entries.slice(i, i + SYNC_BATCH_SIZE)) {
      const key = `push:${entry.kind}:${entry.id}`;
      if (!ctx.retry.ready(key, ctx.now())) continue;
      try {
        const built = await buildRow(ctx, entry, report);
        rows.push(built.row);
        hashes.set(`${entry.kind}:${entry.id}`, built.hash);
        sent.push(entry);
        ctx.retry.succeeded(key);
      } catch (err) {
        if (isNetworkFailure(err)) throw err;
        const issue = { stage: 'upload' as const, kind: entry.kind, id: entry.id, message: message(err) };
        ctx.retry.failed(key, ctx.now(), issue);
        report.issues.push(issue);
      }
    }
    if (rows.length === 0) continue;
    const rejected = await ctx.backend.upsertRecords(rows);
    report.pushed += rows.length - rejected.length;
    report.rejected += rejected.length;
    await confirmPushedFiles(ctx, rows, rejected);
    const rejectedBy = new Map(rejected.map((r) => [`${r.kind}:${r.id}`, r]));
    const accepted = sent.filter((e) => !rejectedBy.has(`${e.kind}:${e.id}`));
    await ackOutbox(accepted);
    await markPushed(rows.filter((r) => !rejectedBy.has(`${r.kind}:${r.id}`)), hashes);
    lost.push(...(await requeueRejected(sent, rejectedBy)));
  }
  return lost;
}

/** Accepted pushes: the pushed version is now the base, and was written in format v2. */
async function markPushed(rows: PushRow[], hashes: Map<string, string | undefined>): Promise<void> {
  if (rows.length === 0) return;
  const keys = rows.map((r) => markKey(r.kind, r.id));
  await db.transaction('rw', db.syncMeta, async () => {
    const current = await db.syncMeta.bulkGet(keys);
    await db.syncMeta.bulkPut(
      rows.map((row, i) => {
        const mark = (current[i]?.value as RecordMark | undefined) ?? { clock: 0, device: '' };
        // `clock` stays what was last pulled: the server may have clamped this row's clock, and
        // the pull of it compares against `clock`. `own` keeps write clocks above it meanwhile.
        const value: RecordMark = defined({
          ...mark,
          own: Math.max(mark.own ?? 0, row.updatedAt),
          hash: row.deleted ? undefined : hashes.get(`${row.kind}:${row.id}`),
          v2: true,
        });
        return { key: keys[i], value };
      })
    );
  });
}

/** See `push`. Returns the rejected entries left for the follow-up pull. */
async function requeueRejected(sent: OutboxEntry[], rejectedBy: Map<string, RejectedRow>): Promise<OutboxEntry[]> {
  const rejected = sent.filter((e) => rejectedBy.has(`${e.kind}:${e.id}`));
  if (rejected.length === 0) return [];
  const marks = await db.syncMeta.bulkGet(rejected.map((e) => markKey(e.kind, e.id)));
  const lost: OutboxEntry[] = [];
  const bumps: { entry: OutboxEntry; clock: number }[] = [];
  rejected.forEach((entry, i) => {
    const server = rejectedBy.get(`${entry.kind}:${entry.id}`)!;
    const mark = marks[i]?.value as RecordMark | undefined;
    if (mark && compareClock(server.updatedAt, server.deviceId, mark.clock, mark.device) <= 0) {
      bumps.push({ entry, clock: server.updatedAt + 1 });
    } else {
      lost.push(entry);
    }
  });
  if (bumps.length > 0) {
    await applyUntracked(async () => {
      const current = await db.outbox.bulkGet(bumps.map((b) => [b.entry.kind, b.entry.id] as [SyncKind, string]));
      const updates = bumps.flatMap((b, i) =>
        current[i]?.rev === b.entry.rev ? [{ ...current[i]!, updatedAt: Math.max(current[i]!.updatedAt, b.clock) }] : []
      );
      await db.outbox.bulkPut(updates);
    });
  }
  return lost;
}

/** The server now references these files: they're safe to reference again for a while. */
async function confirmPushedFiles(ctx: SyncContext, rows: PushRow[], rejected: { kind: string; id: string }[]) {
  const lost = new Set(rejected.map((r) => `${r.kind}:${r.id}`));
  const keys: string[] = [];
  const fileIds: string[] = [];
  for (const row of rows) {
    if (row.deleted || !FILE_KINDS.has(row.kind) || row.files.length === 0 || lost.has(`${row.kind}:${row.id}`)) continue;
    keys.push(fileKey(row.kind, row.id));
    fileIds.push(row.files[0].slice(row.files[0].indexOf('/') + 1));
  }
  if (keys.length === 0) return;
  const now = ctx.now();
  const current = await db.syncMeta.bulkGet(keys);
  const updates = current.flatMap((row, i) => {
    const ref = row?.value as FileRef | undefined;
    return ref && ref.fileId === fileIds[i] ? [{ key: keys[i], value: { ...ref, confirmedAt: now } }] : [];
  });
  await db.syncMeta.bulkPut(updates);
}

/** The row to push for an outbox entry, and (pages) the fingerprint of the pushed version. */
async function buildRow(ctx: SyncContext, entry: OutboxEntry, report: SyncReport): Promise<{ row: PushRow; hash?: string }> {
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
    return { row: tombstone };
  }
  const built = await localPayload(ctx, entry, report);
  // Gone since it was queued (removed by a pulled tombstone): push the deletion
  if (!built) return { row: tombstone };
  const payload = await encryptRecord(
    ctx.vault.key,
    { userId: ctx.userId, kind: entry.kind, id: entry.id },
    built.payload,
    { updatedAt: entry.updatedAt, deviceId: ctx.deviceId, deleted: false }
  );
  const hash = entry.kind === 'page' ? materialHash(built.payload as PagePayload) : undefined;
  return { row: { ...base, deleted: false, payload, files: built.files }, hash };
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
  // Referencing an existing object again is only safe while we know it's there: orphan
  // cleanup elsewhere may have removed one this device hasn't seen referenced for a while
  const fresh = current?.confirmedAt !== undefined && ctx.now() - current.confirmedAt < REUSE_WINDOW_MS;
  if (current && fresh && !changed) return current;

  const sha256 = await digestBlob(blob);
  if (fresh && current?.sha256 === sha256) return current;

  const fileId = nanoid();
  const type = blob.type || (kind === 'signature' ? 'image/png' : 'image/jpeg');
  const sealed = await encryptFile(ctx.vault.key, { userId: ctx.userId, fileId }, blob);
  await ctx.backend.uploadFile(filePath({ userId: ctx.userId, fileId }), sealed);
  const ref: FileRef = { kind, id, userId: ctx.userId, fileId, type, sha256, downloaded: true, confirmedAt: ctx.now() };
  await putFileRef(ref);
  report.uploads++;
  return ref;
}

// --- Pull ---------------------------------------------------------------------------------

interface Decoded {
  row: RemoteRow;
  value?: RecordPayload;
  /** Payload format: 2 authenticates the row's clock, device and deletion flag. */
  format?: 1 | 2;
}

interface Touched {
  documents: Set<string>;
  pages: Set<string>;
}

async function pull(ctx: SyncContext, report: SyncReport, merge: boolean): Promise<void> {
  const touched: Touched = { documents: new Set(), pages: new Set() };
  let cursor = await getCursor(ctx.userId);
  if (ctx.retryBadRows) {
    // Read the unreadable rows again: rewind to just before the oldest. Re-applying rows
    // already applied is harmless (same last-write-wins outcome).
    const bad = (await getMeta<BadRow[]>(badRowsKey(ctx.userId))) ?? [];
    if (bad.length > 0) cursor = Math.min(cursor, Math.min(...bad.map((b) => b.seq)) - 1);
  }

  for (;;) {
    const rows = await ctx.backend.pullRecords(ctx.userId, cursor, SYNC_BATCH_SIZE);
    if (rows.length === 0) break;
    report.pulled += rows.length;

    // Decrypt first: a transaction can't wait on WebCrypto without committing early
    const decoded: Decoded[] = [];
    const bad: BadRow[] = [];
    for (const row of rows) {
      try {
        if (row.deleted) {
          // The schema stores tombstones without a payload; one with a payload is forged
          if (row.payload) throw new Error('Deleted item with content');
          decoded.push({ row });
          continue;
        }
        if (!row.payload) throw new Error('Missing payload');
        const opened = await openRecord(ctx.vault.key, { userId: ctx.userId, kind: row.kind, id: row.id }, row.payload, {
          deviceId: row.deviceId,
          deleted: false,
        });
        // The server may lower a clock (its +5 min clamp), never raise one
        if (opened.format === 2 && row.updatedAt > opened.updatedAt!) throw new Error('Clock doesn’t match the item');
        if (!isValidPayload(row.kind, opened.value)) throw new Error(`Unsupported ${row.kind} payload`);
        decoded.push({ row, value: opened.value, format: opened.format });
      } catch (err) {
        // Recorded and skipped; the cursor still moves past it so one bad row can't stall sync
        report.issues.push({ stage: 'pull', kind: row.kind, id: row.id, message: message(err) });
        bad.push({ kind: row.kind, id: row.id, seq: row.seq, message: message(err) });
      }
    }

    const lastSeq = rows[rows.length - 1].seq;
    await applyBatch(ctx, decoded, bad, merge, touched, report, lastSeq);
    cursor = lastSeq;
    if (rows.length < SYNC_BATCH_SIZE) break;
  }

  await normalizeDocuments(ctx, touched);
}

const MAX_BAD_ROWS = 200;

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
    return this.putEntries().map(([, v]) => v);
  }
  putEntries(): [string, T][] {
    return [...this.dirty].flatMap((id) => {
      const value = this.values.get(id);
      return value != null ? [[id, value] as [string, T]] : [];
    });
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
  /** Record markers by syncMeta key. */
  marks: Working<RecordMark>;
  outbox: OutboxEntry[];
  /** Pending local changes that lost to a pulled version: dropped. */
  dropped: [SyncKind, string][];
}

/**
 * Apply one pulled batch in one untracked transaction: read what the rows touch, work out the
 * result in memory, write it, save the cursor. Only direct Dexie calls inside the transaction:
 * awaiting nested native async helpers can drop Dexie's transaction zone and commit it early.
 */
async function applyBatch(
  ctx: SyncContext,
  decoded: Decoded[],
  bad: BadRow[],
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
      marks: new Working(),
      outbox: [],
      dropped: [],
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
    const markKeys = decoded.map((d) => markKey(d.row.kind, d.row.id));
    state.marks.load(pair(markKeys, (await db.syncMeta.bulkGet(markKeys)).map((r) => r?.value as RecordMark | undefined)));

    const replays: BadRow[] = [];
    decoded.forEach((item, i) => {
      const refused = applyRow(ctx, item, pending[i], merge, state, touched, report);
      if (!refused) return;
      const { kind, id, seq } = item.row;
      report.replayed++;
      report.issues.push({ stage: 'pull', kind, id, message: refused });
      replays.push({ kind, id, seq, message: refused });
    });

    // Lost pending changes go before the entries this batch queues (which may be for the
    // same record: a merge reviving a deleted one)
    await db.outbox.bulkDelete(state.dropped);
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
    await db.syncMeta.bulkPut(state.marks.putEntries().map(([key, value]) => ({ key, value })));
    await db.outbox.bulkPut(state.outbox);
    // Unreadable rows (and replays): newly failing ones are added, ones that now read fine (or
    // were replaced by a readable version) drop out
    const badKey = badRowsKey(ctx.userId);
    const refusedKeys = new Set(replays.map((b) => `${b.kind}:${b.id}`));
    const readable = new Set(decoded.map((d) => `${d.row.kind}:${d.row.id}`).filter((k) => !refusedKeys.has(k)));
    const failingRows = [...bad, ...replays];
    const failing = new Set(failingRows.map((b) => `${b.kind}:${b.id}`));
    const previous = ((await db.syncMeta.get(badKey))?.value as BadRow[] | undefined) ?? [];
    const kept = previous.filter((b) => !readable.has(`${b.kind}:${b.id}`) && !failing.has(`${b.kind}:${b.id}`));
    const nextBad = [...kept, ...failingRows].slice(-MAX_BAD_ROWS);
    if (nextBad.length > 0) await db.syncMeta.put({ key: badKey, value: nextBad });
    else if (previous.length > 0) await db.syncMeta.delete(badKey);
    await db.syncMeta.put({ key: cursorKey(ctx.userId), value: lastSeq });
  });
}

const REPLAYED = 'The server sent an older version of this item again; it was ignored.';
const DOWNGRADED = 'The server sent an older, unprotected version of this item; it was ignored.';

/**
 * Last-write-wins for one pulled row against this device's pending change, with replay
 * checks and conflicted copies (see the rules at the top). Synchronous. Returns why the row
 * was refused, or null when it was applied or lost to the pending change.
 */
function applyRow(
  ctx: SyncContext,
  { row, value, format }: Decoded,
  pending: OutboxEntry | undefined,
  merge: boolean,
  state: BatchState,
  touched: Touched,
  report: SyncReport
): string | null {
  const key = markKey(row.kind, row.id);
  const mark = state.marks.get(key);
  const vsMark = mark ? compareClock(row.updatedAt, row.deviceId, mark.clock, mark.device) : 1;
  if (vsMark < 0) return REPLAYED;
  if (mark?.v2 && format === 1) return DOWNGRADED;

  const next: RecordMark = defined({ ...mark, clock: row.updatedAt, device: row.deviceId, v2: mark?.v2 || format === 2 || undefined });
  // A concurrent edit: a version this device hasn't seen, from another device, while a local
  // change of the same record waits. (Merges are plain last-write-wins.)
  const concurrent = !merge && vsMark > 0 && row.deviceId !== ctx.deviceId && pending?.op === 'upsert';

  if (pending && compareClock(pending.updatedAt, ctx.deviceId, row.updatedAt, row.deviceId) >= 0) {
    // The local change wins and will overwrite this version on the server
    if (concurrent && row.kind === 'page' && !row.deleted && value) {
      keepRemoteLoser(ctx, row, value as PagePayload, pending, mark, state, touched, report);
    } else if (concurrent) {
      report.conflicts.push({ kind: row.kind, id: row.id, loser: 'remote' });
    }
    state.marks.set(key, next);
    report.skipped++;
    return null;
  }

  // The remote version wins; the pending change is lost
  if (concurrent && row.kind === 'page' && !row.deleted && value) {
    keepLocalLoser(ctx, row, value as PagePayload, mark, state, touched, report);
  } else if (concurrent) {
    report.conflicts.push({ kind: row.kind, id: row.id, loser: 'local' });
  }
  if (pending) state.dropped.push([row.kind, row.id]);
  if (row.deleted) {
    applyTombstone(ctx, row, merge, state, touched, pending);
  } else if (value) {
    applyUpsert(ctx, row, value, state, touched);
  }
  next.hash = row.kind === 'page' && !row.deleted && value ? materialHash(value as PagePayload) : undefined;
  state.marks.set(key, defined(next));
  report.applied++;
  return null;
}

/**
 * The pulled page wins over this device's pending edit. Keep the local version as a
 * conflicted copy if the edit changed something that matters and the winner doesn't already
 * have the same.
 */
function keepLocalLoser(
  ctx: SyncContext,
  row: RemoteRow,
  winner: PagePayload,
  mark: RecordMark | undefined,
  state: BatchState,
  touched: Touched,
  report: SyncReport
) {
  const local = state.pages.get(row.id);
  if (!local) return;
  const loser = materialHash(local);
  if ((mark?.hash !== undefined && loser === mark.hash) || loser === materialHash(winner)) {
    report.conflicts.push({ kind: 'page', id: row.id, loser: 'local' });
    return;
  }
  const ref = state.refs.get(fileKey('page', row.id));
  const copyId = addConflictCopy(
    ctx,
    state,
    touched,
    defined({
      documentId: winner.documentId,
      pageNumber: winner.pageNumber,
      corners: local.corners,
      filter: local.filter,
      rotation: local.rotation,
      ocrText: local.ocrText,
      ocrWords: local.ocrWords,
      ocrLang: local.ocrLang,
      ocrInfo: local.ocrInfo,
      annotations: local.annotations,
      conflictOf: row.id,
      originalBlob: local.originalBlob,
      processedBlob: local.processedBlob,
      ocrStatus: local.ocrStatus === 'processing' ? 'pending' : local.ocrStatus,
    }),
    ref?.userId === ctx.userId ? ref : undefined
  );
  report.conflicts.push({ kind: 'page', id: row.id, copyId, loser: 'local' });
}

/**
 * This device's pending edit wins over the pulled page. Keep the pulled version as a
 * conflicted copy if it changed something that matters and the local version doesn't already
 * have the same.
 */
function keepRemoteLoser(
  ctx: SyncContext,
  row: RemoteRow,
  loser: PagePayload,
  pending: OutboxEntry,
  mark: RecordMark | undefined,
  state: BatchState,
  touched: Touched,
  report: SyncReport
) {
  const local = state.pages.get(row.id);
  const hash = materialHash(loser);
  if ((mark?.hash !== undefined && hash === mark.hash) || (local && hash === materialHash(local))) {
    report.conflicts.push({ kind: 'page', id: row.id, loser: 'remote' });
    return;
  }
  // Its image: the local one if it's the same file, otherwise downloaded like any pulled file
  const ref = state.refs.get(fileKey('page', row.id));
  const sameImage =
    loser.file && ref?.userId === ctx.userId && ref.fileId === loser.file.id && ref.downloaded && !pending.fileChanged;
  const fileRef: FileRef | undefined = sameImage
    ? ref
    : loser.file && { kind: 'page', id: row.id, userId: ctx.userId, fileId: loser.file.id, type: loser.file.type, downloaded: false, confirmedAt: ctx.now() };
  const hasOcr = loser.ocrText !== undefined || loser.ocrInfo !== undefined;
  const copyId = addConflictCopy(
    ctx,
    state,
    touched,
    defined({
      documentId: local?.documentId ?? loser.documentId,
      pageNumber: local?.pageNumber ?? loser.pageNumber,
      corners: loser.corners,
      filter: loser.filter,
      rotation: loser.rotation,
      ocrText: loser.ocrText,
      ocrWords: loser.ocrWords,
      ocrLang: loser.ocrLang,
      ocrInfo: loser.ocrInfo,
      annotations: loser.annotations,
      conflictOf: row.id,
      processedBlob: sameImage ? local?.processedBlob : undefined,
      ocrStatus: hasOcr ? ('done' as const) : undefined,
    }),
    fileRef
  );
  report.conflicts.push({ kind: 'page', id: row.id, copyId, loser: 'remote' });
}

/** Add a conflicted copy (a new page, queued like a local one). Returns its id. */
function addConflictCopy(
  ctx: SyncContext,
  state: BatchState,
  touched: Touched,
  fields: Omit<Page, 'id' | 'createdAt' | 'updatedAt'>,
  ref: FileRef | undefined
): string {
  const id = nanoid();
  const now = ctx.now();
  const page: Page = { ...fields, id, createdAt: new Date(now), updatedAt: new Date(now) };
  state.pages.set(id, page);
  if (ref) state.refs.set(fileKey('page', id), { ...ref, id });
  state.outbox.push({ kind: 'page', id, op: 'upsert', updatedAt: now, fileChanged: page.processedBlob != null, rev: 1 });
  touched.documents.add(page.documentId);
  touched.pages.add(id);
  return id;
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
      // Pulled text is final; without any, leave local recognition as it was (the device that
      // has the image recognizes it and syncs the text)
      let ocrStatus: Page['ocrStatus'] = hasOcr ? 'done' : existing?.ocrStatus === 'done' ? undefined : existing?.ocrStatus;
      // A page without text that this device never recognized: recognize it here once its
      // image is here (now, if it already is; otherwise when it downloads)
      const ref = state.refs.get(fileKey('page', id));
      if (!hasOcr && existing && existing.ocrStatus === undefined && existing.processedBlob && ref?.downloaded) {
        ocrStatus = 'pending';
      }
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
          conflictOf: p.conflictOf,
          createdAt: p.createdAt,
          updatedAt: new Date(row.updatedAt),
          // The original never syncs; it exists only on the device that captured the page.
          // Until a changed image downloads, the previous one keeps showing.
          originalBlob: existing?.originalBlob,
          processedBlob: existing?.processedBlob,
          ocrStatus,
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
  // The server references this file right now
  const confirmedAt = ctx.now();
  if (ref && ref.userId === ctx.userId && ref.fileId === file.id) {
    state.refs.set(key, pendingSignature && !ref.downloaded ? { ...ref, pendingSignature, confirmedAt } : { ...ref, confirmedAt });
    return;
  }
  state.refs.set(
    key,
    defined({ kind, id, userId: ctx.userId, fileId: file.id, type: file.type, downloaded: false, pendingSignature, confirmedAt })
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
 * Page order after a pull: by (pageNumber, id), except that a conflicted copy goes right after
 * the page it's a copy of (copies of one page by id). Every device computes the same order
 * from the same pages, whatever page numbers the copy was pushed with.
 */
export function orderPages<T extends Pick<Page, 'id' | 'pageNumber' | 'conflictOf'>>(pages: T[]): T[] {
  const byId = (a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = [...pages].sort((a, b) => a.pageNumber - b.pageNumber || byId(a, b));
  const ids = new Set(sorted.map((p) => p.id));
  const copies = new Map<string, T[]>();
  const main: T[] = [];
  for (const page of sorted) {
    const of = page.conflictOf;
    if (of && of !== page.id && ids.has(of)) copies.set(of, [...(copies.get(of) ?? []), page]);
    else main.push(page);
  }
  const out: T[] = [];
  const placed = new Set<string>();
  const place = (page: T) => {
    if (placed.has(page.id)) return;
    placed.add(page.id);
    out.push(page);
    for (const copy of (copies.get(page.id) ?? []).sort(byId)) place(copy);
  };
  main.forEach(place);
  // Copies of copies in a loop can't be reached from a main page: keep them, in plain order
  sorted.forEach(place);
  return out;
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
      const pages = orderPages(await db.pages.where('documentId').equals(docId).toArray());
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
  ctx.retry.retain('download:', new Set(due.map((r) => `download:${r.kind}:${r.id}:${r.fileId}`)));
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
      const issue = { stage: 'download' as const, kind: ref.kind, id: ref.id, message: message(err) };
      ctx.retry.failed(key, ctx.now(), issue);
      report.issues.push(issue);
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
    // A pulled page without text that this device never recognized: queue it for OCR now
    // that its image is here (OcrRunner picks it up; the text syncs back as a normal edit)
    const needsOcr = page.ocrText === undefined && page.ocrInfo === undefined && page.ocrStatus === undefined;
    await db.pages.update(ref.id, needsOcr ? { processedBlob: blob, ocrStatus: 'pending' } : { processedBlob: blob });
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

