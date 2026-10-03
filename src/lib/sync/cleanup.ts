import { db } from '@/lib/db';
import type { SyncBackend, StoredFile } from './backend';
import { cleanupKey, FILE_PREFIX, type CleanupState, type FileRef } from './state';

/*
 * Orphaned file removal. Every changed image is uploaded under a fresh object name, so replaced
 * images, deleted pages and signatures, and uploads whose push failed or was rejected leave
 * objects in `vault/<userId>/` that no record references. This removes them, at most once a
 * day per device, after a successful push.
 *
 * Safety:
 * 1. Referenced = every `files` entry of the account's live (not deleted) records on the server,
 *    read in full (paginated by seq), plus every file this device maps a record to (which
 *    covers its own uploads that aren't pushed yet). If the server list can't be read
 *    completely, nothing is deleted.
 * 2. Two phases: an unreferenced object only becomes a candidate (with the time it was first
 *    seen); it's deleted by a later cleanup at least ORPHAN_GRACE_MS after that, if it's still
 *    unreferenced then. An object referenced again in between drops out of the candidates.
 * 3. Objects younger than FRESH_UPLOAD_MS (by Storage's `created_at`) are never candidates, so
 *    another device's upload whose record hasn't landed yet is left alone.
 * 4. A device references an existing object again only within REUSE_WINDOW_MS (< grace) of
 *    last confirming it exists (FileRef.confirmedAt); otherwise it uploads a fresh copy. So a
 *    device that has been away can't re-point a record at an object that was deleted meanwhile.
 *    The windows are measured on each device's own clock, so clock skew between devices
 *    doesn't matter.
 * Work per run is bounded (pages listed, objects deleted); leftovers go next time.
 */

export const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
export const ORPHAN_GRACE_MS = 24 * 60 * 60_000;
export const FRESH_UPLOAD_MS = 60 * 60_000;
export const REUSE_WINDOW_MS = 6 * 60 * 60_000;

const REFERENCE_PAGE = 1000;
const MAX_REFERENCE_PAGES = 1000;
const LIST_PAGE = 1000;
const MAX_LIST_PAGES = 50;
const REMOVE_BATCH = 100;
export const MAX_DELETES_PER_RUN = 1000;

export interface CleanupResult {
  /** False when skipped (ran recently) or aborted (incomplete reference list). */
  ran: boolean;
  deleted: number;
  /** Unreferenced objects waiting out the grace period. */
  candidates: number;
}

export async function getCleanupState(userId: string): Promise<CleanupState | undefined> {
  return (await db.syncMeta.get(cleanupKey(userId)))?.value as CleanupState | undefined;
}

/** Every object name the server's live records reference, or null if the list is incomplete. */
async function serverReferences(backend: SyncBackend, userId: string): Promise<Set<string> | null> {
  const referenced = new Set<string>();
  let after = 0;
  for (let page = 0; page < MAX_REFERENCE_PAGES; page++) {
    const { rows, lastSeq, files } = await backend.listReferencedFiles(userId, after, REFERENCE_PAGE);
    for (const f of files) referenced.add(f);
    if (rows < REFERENCE_PAGE) return referenced;
    after = lastSeq;
  }
  return null;
}

async function listObjects(backend: SyncBackend, userId: string): Promise<{ files: StoredFile[]; complete: boolean }> {
  const files: StoredFile[] = [];
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const batch = await backend.listFiles(userId, page * LIST_PAGE, LIST_PAGE);
    files.push(...batch);
    if (batch.length < LIST_PAGE) return { files, complete: true };
  }
  return { files, complete: false };
}

/**
 * Run the cleanup if it's due. Network errors propagate (the caller treats cleanup as
 * best-effort); state is saved only after a complete pass.
 */
export async function cleanupOrphanedFiles(
  backend: SyncBackend,
  userId: string,
  now: number,
  options: { force?: boolean } = {}
): Promise<CleanupResult> {
  const previous = await getCleanupState(userId);
  if (!options.force && previous && now - previous.lastRunAt < CLEANUP_INTERVAL_MS) {
    return { ran: false, deleted: 0, candidates: Object.keys(previous.candidates).length };
  }

  const referenced = await serverReferences(backend, userId);
  if (!referenced) return { ran: false, deleted: 0, candidates: Object.keys(previous?.candidates ?? {}).length };
  const { files, complete } = await listObjects(backend, userId);
  // Read the local mappings last: an upload made while listing is still protected
  const refs = await db.syncMeta.where('key').startsWith(FILE_PREFIX).toArray();
  for (const row of refs) {
    const ref = row.value as FileRef;
    if (ref.userId === userId) referenced.add(`${ref.userId}/${ref.fileId}`);
  }

  const seen = previous?.candidates ?? {};
  const candidates: Record<string, number> = {};
  const due: string[] = [];
  for (const file of files) {
    if (referenced.has(file.path) || !file.path.startsWith(`${userId}/`)) continue;
    if (now - file.createdAt < FRESH_UPLOAD_MS) continue;
    const firstSeen = seen[file.path] ?? now;
    if (now - firstSeen >= ORPHAN_GRACE_MS && due.length < MAX_DELETES_PER_RUN) due.push(file.path);
    else candidates[file.path] = firstSeen;
  }

  let deleted = 0;
  try {
    for (let i = 0; i < due.length; i += REMOVE_BATCH) {
      const batch = due.slice(i, i + REMOVE_BATCH);
      await backend.removeFiles(batch);
      deleted += batch.length;
    }
  } finally {
    // Whatever wasn't deleted stays a candidate with its original first-seen time
    for (const path of due.slice(deleted)) candidates[path] = seen[path];
    const deletedSet = new Set(due.slice(0, deleted));
    const state: CleanupState = {
      lastRunAt: deleted === due.length ? now : previous?.lastRunAt ?? 0,
      candidates,
      usage: complete
        ? {
            bytes: files.filter((f) => !deletedSet.has(f.path)).reduce((sum, f) => sum + f.size, 0),
            files: files.length - deleted,
            at: now,
          }
        : previous?.usage,
    };
    await db.syncMeta.put({ key: cleanupKey(userId), value: state });
  }
  return { ran: true, deleted, candidates: Object.keys(candidates).length };
}
