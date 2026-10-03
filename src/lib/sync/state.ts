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
 *
 * Use these helpers inside `applyUntracked` (which includes syncMeta) when they must commit
 * together with a record write.
 */

export const LAST_USER_KEY = 'sync:lastUserId';
const CURSOR_PREFIX = 'sync:cursor:';
const MERGE_PREFIX = 'sync:merge:';
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
  /** A pulled signature waits here until its image arrives (it can't exist without one). */
  pendingSignature?: Omit<SignaturePayload, 'file'>;
}

export const fileKey = (kind: string, id: string) => `${FILE_PREFIX}${kind}:${id}`;
export const cursorKey = (userId: string) => `${CURSOR_PREFIX}${userId}`;
export const mergeKey = (userId: string) => `${MERGE_PREFIX}${userId}`;

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
export class RetryTracker {
  private failures = new Map<string, { attempts: number; notBefore: number }>();

  constructor(
    private readonly baseMs = 5_000,
    private readonly maxMs = 60 * 60_000
  ) {}

  ready(key: string, now: number): boolean {
    const f = this.failures.get(key);
    return !f || f.notBefore <= now;
  }

  failed(key: string, now: number): void {
    const attempts = (this.failures.get(key)?.attempts ?? 0) + 1;
    const delay = Math.min(this.maxMs, this.baseMs * 2 ** (attempts - 1));
    this.failures.set(key, { attempts, notBefore: now + delay });
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
