import Dexie from 'dexie';
import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import { markUntracked, type OutboxEntry, type SyncKind } from '@/lib/sync-tracking';

/*
 * What the sync engine (step 6) uses on top of the change tracking in sync-tracking.ts.
 * Nothing here talks to the network.
 */

export type { OutboxEntry, SyncKind } from '@/lib/sync-tracking';
export { SYNCED_SETTING_KEYS } from '@/lib/sync-tracking';

const DEVICE_ID_KEY = 'deviceId';

/**
 * Random id of this install, created on first use. It lives in `syncMeta`, which never
 * syncs, and is the tie-breaker when two writes carry the same `updatedAt`.
 */
export async function getDeviceId(): Promise<string> {
  const stored = await db.syncMeta.get(DEVICE_ID_KEY);
  if (typeof stored?.value === 'string') return stored.value;
  return db.transaction('rw', db.syncMeta, async () => {
    // Another tab may have created it in the meantime
    const row = await db.syncMeta.get(DEVICE_ID_KEY);
    if (typeof row?.value === 'string') return row.value;
    const id = nanoid();
    await db.syncMeta.put({ key: DEVICE_ID_KEY, value: id });
    return id;
  });
}

/** Pending changes, oldest first. Each one is an upsert of the current local record or a tombstone. */
export function readOutbox(limit?: number): Promise<OutboxEntry[]> {
  const ordered = db.outbox.orderBy('updatedAt');
  return (limit ? ordered.limit(limit) : ordered).toArray();
}

/** The pending local change for a record, if any — what a pulled remote row is compared against. */
export function getOutboxEntry(kind: SyncKind, id: string): Promise<OutboxEntry | undefined> {
  return db.outbox.get([kind, id]);
}

/**
 * Drop entries the server has accepted (or rejected for good). An entry changed again
 * since it was read (different `rev`) stays queued, so the newer edit still gets pushed.
 */
export async function ackOutbox(entries: readonly Pick<OutboxEntry, 'kind' | 'id' | 'rev'>[]): Promise<void> {
  if (entries.length === 0) return;
  await db.transaction('rw', db.outbox, async () => {
    const current = await db.outbox.bulkGet(entries.map((e) => [e.kind, e.id] as [SyncKind, string]));
    const done = entries.filter((e, i) => current[i]?.rev === e.rev).map((e) => [e.kind, e.id] as [SyncKind, string]);
    await db.outbox.bulkDelete(done);
  });
}

/**
 * Run `fn` in a read-write transaction whose writes are not recorded in the outbox — for
 * applying pulled remote changes, which must not be pushed back. Writes keep the values
 * they're given (a page's `updatedAt` isn't bumped). Must be called outside any transaction.
 */
export function applyUntracked<T>(fn: () => Promise<T>): Promise<T> {
  if (Dexie.currentTransaction) {
    return Promise.reject(new Error('applyUntracked must not run inside another transaction'));
  }
  return db.transaction(
    'rw',
    [db.documents, db.pages, db.images, db.folders, db.signatures, db.settings, db.outbox, db.syncMeta],
    (tx) => {
      markUntracked(tx.idbtrans);
      return fn();
    }
  );
}
