import { db } from '@/lib/db';
import type { SyncKind } from '@/lib/outbox';
import type { SignaturePayload } from './payload';

/*
 * Device-local sync state, kept in `syncMeta` (never synced):
 *
 *   sync:lastUserId           the account this device last synced with
 *   sync:cursor:<userId>      highest `records.seq` applied, per account
 *   sync:merge:<userId>       set while the first sync with an account (a merge) is unfinished
 *   sync:file:<kind>:<id>     the record's current remote file (FileRef)
 *   sync:cleanup:<userId>     orphaned-file cleanup: last run, candidates, storage usage
 *   sync:bad:<userId>         pulled rows that couldn't be read (retried on demand)
 *   sync:mark:<kind>:<id>     the record's sync marker (RecordMark): newest version seen, base
 *   sync:marksReady:<userId>  base markers were initialised for records synced before they existed
 *   sync:accountSwitch        the user's answer to "upload this device's documents to the new account?"
 *
 * Everything under `sync:` belongs to the account in `sync:lastUserId` and is wiped when a
 * different account starts its first sync on this device.
 *
 * Use these helpers inside `applyUntracked` (which includes syncMeta) when they must commit
 * together with a record write.
 */

export { markKey, MARK_PREFIX } from '@/lib/sync-tracking';

/**
 * What this device knows about a record's server versions:
 *
 * - `clock`/`device`: the newest version (by last-write-wins order, the row clock as the
 *   server stored it) this device has pulled. A later pull of anything older is a replay and
 *   is rejected, and a local write is clocked at least 1 ms past it (`writeClock`). 0/'' when
 *   unknown.
 * - `own`: the clock of this device's last accepted push of the record. Kept apart from
 *   `clock` because the server may have stored it clamped; write clocks stay above both.
 * - `hash`: the material fingerprint (`materialHash`) of the base version, the last version
 *   this device and the server agreed on (applied from a pull, or pushed and accepted). A
 *   local or remote version that differs from it changed something that matters. Pages only.
 * - `v2`: a version authenticated with its clock (record format v2) was seen or written, so a
 *   v1 payload for this record can only be a downgrade replay.
 */
export interface RecordMark {
  clock: number;
  device: string;
  own?: number;
  hash?: string;
  v2?: boolean;
}

export const ACCOUNT_SWITCH_KEY = 'sync:accountSwitch';

/** The user's answer when a different account signs in on a device with another account's data. */
export interface AccountSwitchDecision {
  from: string;
  to: string;
  choice: 'merge' | 'remove';
}

export const LAST_USER_KEY = 'sync:lastUserId';
const CURSOR_PREFIX = 'sync:cursor:';
const MERGE_PREFIX = 'sync:merge:';
const CLEANUP_PREFIX = 'sync:cleanup:';
const BAD_ROWS_PREFIX = 'sync:bad:';
export const FILE_PREFIX = 'sync:file:';

/** Where a record's synced file lives remotely, and whether this device has its bytes. */
export interface FileRef {
  kind: Extract<SyncKind, 'page' | 'signature'>;
  id: string;
  userId: string;
  /** Storage object `<userId>/<fileId>`; fresh for every upload. */
  fileId: string;
  type: string;
  /** SHA-256 (hex) of the plaintext; lets an unchanged file skip re-upload. */
  sha256?: string;
  /** False until a pulled file has been downloaded and stored locally. */
  downloaded: boolean;
  /**
   * Epoch ms (this device's clock) when this device last knew the object exists: it uploaded
   * it, a push referencing it was accepted, or a pull showed a record referencing it. A file
   * not confirmed recently is uploaded afresh rather than referenced again, because orphan
   * cleanup on another device may have removed it since (see cleanup.ts).
   */
  confirmedAt?: number;
  /** A pulled signature waits here until its image arrives (it can't exist without one). */
  pendingSignature?: Omit<SignaturePayload, 'file'>;
}

export const fileKey = (kind: string, id: string) => `${FILE_PREFIX}${kind}:${id}`;
export const cursorKey = (userId: string) => `${CURSOR_PREFIX}${userId}`;
export const mergeKey = (userId: string) => `${MERGE_PREFIX}${userId}`;
export const cleanupKey = (userId: string) => `${CLEANUP_PREFIX}${userId}`;
export const badRowsKey = (userId: string) => `${BAD_ROWS_PREFIX}${userId}`;
export const marksReadyKey = (userId: string) => `sync:marksReady:${userId}`;

/** A pulled row that couldn't be decrypted or had an unknown shape; the cursor moved past it. */
export interface BadRow {
  kind: string;
  id: string;
  seq: number;
  message: string;
}

/** Orphaned-file cleanup state per account (see cleanup.ts). */
export interface CleanupState {
  /** Epoch ms of the last completed cleanup. */
  lastRunAt: number;
  /** Unreferenced object name -> epoch ms it was first seen unreferenced. */
  candidates: Record<string, number>;
  /** Total size of the account's objects at the last cleanup (only from a complete listing). */
  usage?: { bytes: number; files: number; at: number };
}

export async function getFileRef(kind: FileRef['kind'], id: string): Promise<FileRef | undefined> {
  const row = await db.syncMeta.get(fileKey(kind, id));
  return row?.value as FileRef | undefined;
}

export async function putFileRef(ref: FileRef): Promise<void> {
  await db.syncMeta.put({ key: fileKey(ref.kind, ref.id), value: ref });
}

export async function deleteFileRef(kind: FileRef['kind'], id: string): Promise<void> {
  await db.syncMeta.delete(fileKey(kind, id));
}

export async function listFileRefs(): Promise<FileRef[]> {
  const rows = await db.syncMeta.where('key').startsWith(FILE_PREFIX).toArray();
  return rows.map((r) => r.value as FileRef);
}

export async function getCursor(userId: string): Promise<number> {
  const row = await db.syncMeta.get(cursorKey(userId));
  return typeof row?.value === 'number' ? row.value : 0;
}

export async function setCursor(userId: string, seq: number): Promise<void> {
  await db.syncMeta.put({ key: cursorKey(userId), value: seq });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.syncMeta.get(key))?.value as T | undefined;
}

/** SHA-256 of a blob as hex. */
export async function digestBlob(blob: Blob): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
  return Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Per-item exponential backoff (failed uploads, downloads, records that can't be encoded).
 * In memory: a reload retries everything at once, which is fine.
 */
export interface RetryInfo {
  stage: string;
  kind: string;
  id: string;
  message: string;
}

export interface RetryProblem extends RetryInfo {
  attempts: number;
  notBefore: number;
}

export class RetryTracker {
  private failures = new Map<string, { attempts: number; notBefore: number; info?: RetryInfo }>();

  constructor(
    private readonly baseMs = 5_000,
    private readonly maxMs = 60 * 60_000
  ) {}

  ready(key: string, now: number): boolean {
    const f = this.failures.get(key);
    return !f || f.notBefore <= now;
  }

  failed(key: string, now: number, info?: RetryInfo): void {
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** (attempts - 1));
    this.failures.set(key, { attempts, notBefore: now + delay, info: info ?? this.failures.get(key)?.info });
  }

  /** Forget failures under `prefix` whose key isn't in `keep` (the item is gone). */
  retain(prefix: string, keep: Set<string>): void {
    for (const key of this.failures.keys()) if (key.startsWith(prefix) && !keep.has(key)) this.failures.delete(key);
  }

  /** Items currently failing, for the UI. */
  problems(): RetryProblem[] {
    return [...this.failures.values()]
      .filter((f) => f.info)
      .map((f) => ({ ...f.info!, attempts: f.attempts, notBefore: f.notBefore }));
  }

  succeeded(key: string): void {
    this.failures.delete(key);
  }

  attempts(key: string): number {
    return this.failures.get(key)?.attempts ?? 0;
  }

  /** The earliest time something is due again, if anything is waiting. */
  nextRetryAt(): number | undefined {
    let next: number | undefined;
    for (const f of this.failures.values()) if (next === undefined || f.notBefore < next) next = f.notBefore;
    return next;
  }

  clear(): void {
    this.failures.clear();
  }
}
