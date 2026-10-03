import type { DBCore, DBCoreMutateRequest, DBCoreTable, DBCoreTransaction, Middleware } from 'dexie';

/*
 * Change tracking for cloud sync: a Dexie DBCore middleware that records every local
 * create / update / delete of a synced record in the `outbox` table, in the same
 * transaction as the write. No network here — the sync engine reads the outbox later.
 *
 * - One entry per (kind, id): repeated changes coalesce. A delete leaves an entry with
 *   op 'delete' — that entry is the tombstone.
 * - `updatedAt` on the entry is the time of the latest local write (epoch ms) and is the
 *   last-write-wins clock — at least 1 ms past the newest version of the record this device
 *   has seen, so a skewed clock can't make an edit lose to the version it was made on (see
 *   `writeClock`). It is not taken from the record: some document writes
 *   (auto-name, summary, search text) deliberately leave `document.updatedAt` alone so
 *   the gallery order doesn't change.
 * - Writes in a versionchange (schema upgrade) transaction or one marked with
 *   `markUntracked` (remote changes applied by the sync engine) are not recorded.
 */

export type SyncKind = 'document' | 'page' | 'folder' | 'signature' | 'settings';

export interface OutboxEntry {
  kind: SyncKind;
  id: string;
  op: 'upsert' | 'delete';
  /** Time of the latest local write (epoch ms) — the last-write-wins clock, with the device id as tie-breaker. */
  updatedAt: number;
  /** The synced file (page processedBlob / signature PNG) changed since the last push; always false for deletes. */
  fileChanged: boolean;
  /** Bumped on every coalesced change, so acknowledging a pushed entry never drops a newer edit. */
  rev: number;
}

export const OUTBOX_TABLE = 'outbox';
const META_TABLE = 'syncMeta';

/** How far ahead of this device's clock a write clock may go; the server clamps at the same. */
export const MAX_CLOCK_LEAD_MS = 5 * 60_000;

/**
 * `syncMeta` key of a record's sync marker (`RecordMark` in sync/state.ts). Defined here
 * because the tracking reads the marker's clock for every write.
 */
export const MARK_PREFIX = 'sync:mark:';
export const markKey = (kind: string, id: string) => `${MARK_PREFIX}${kind}:${id}`;

/** Settings keys that sync; every other setting (LLM keys and endpoints included) stays on the device. */
export const SYNCED_SETTING_KEYS: readonly string[] = ['ocrLanguages'];

interface TrackedTable {
  kind: SyncKind;
  /** Fields that never sync: a write that only touches these isn't recorded. */
  localOnly: readonly string[];
  /** The synced binary, pushed only when it changed. */
  file?: string;
}

export const TRACKED_TABLES: Readonly<Record<string, TrackedTable>> = {
  documents: { kind: 'document', localOnly: ['thumbnailBlob'] },
  pages: { kind: 'page', localOnly: ['originalBlob', 'ocrStatus'], file: 'processedBlob' },
  folders: { kind: 'folder', localOnly: [] },
  signatures: { kind: 'signature', localOnly: [], file: 'blob' },
  settings: { kind: 'settings', localOnly: [] },
};

const UNTRACKED = Symbol('quickscan.untracked');

type TransFlags = DBCoreTransaction & { mode?: IDBTransactionMode; [UNTRACKED]?: boolean };

/** Exclude every write in this (core) transaction from change tracking. */
export function markUntracked(trans: unknown): void {
  (trans as TransFlags)[UNTRACKED] = true;
}

function isTracked(trans: DBCoreTransaction): boolean {
  const t = trans as TransFlags;
  return t.mode !== 'versionchange' && !t[UNTRACKED];
}

interface Change {
  id: string;
  op: 'upsert' | 'delete';
  fileChanged: boolean;
}

type ChangeSpec = Record<string, unknown> | undefined;

/**
 * The last-write-wins clock for a local write (a hybrid logical clock, per record): the wall
 * clock, but at least 1 ms past the newest version of the record this device has seen from
 * any device (`seen`), so an edit made after seeing a version always beats it even when this
 * device's clock is behind. Capped at now + 5 minutes, where the server clamps clocks too.
 */
export function writeClock(now: number, seen: number | undefined): number {
  const wanted = seen === undefined ? now : Math.max(now, seen + 1);
  return Math.min(wanted, now + MAX_CLOCK_LEAD_MS);
}

/** Merge a new change into the pending entry for the same record. */
export function coalesce(
  prev: OutboxEntry | undefined,
  kind: SyncKind,
  change: Change,
  now: number,
  seen?: number
): OutboxEntry {
  const upsert = change.op === 'upsert';
  return {
    kind,
    id: change.id,
    op: change.op,
    updatedAt: Math.max(prev?.updatedAt ?? 0, writeClock(now, seen)),
    fileChanged: upsert && (change.fileChanged || (prev?.op === 'upsert' && prev.fileChanged)),
    rev: (prev?.rev ?? 0) + 1,
  };
}

function topLevelFields(spec: Record<string, unknown>): string[] {
  return Object.keys(spec).map((k) => k.split('.')[0]);
}

function trackTable(down: DBCoreTable, outbox: DBCoreTable, meta: DBCoreTable, tracked: TrackedTable): DBCoreTable {
  const extractKey = down.schema.primaryKey.extractKey!;
  const isSettings = tracked.kind === 'settings';
  const syncsId = (id: string) => !isSettings || SYNCED_SETTING_KEYS.includes(id);

  async function enqueue(trans: DBCoreTransaction, changes: Change[], now: number) {
    if (changes.length === 0) return;
    // Last change per id wins within one request
    const byId = new Map(changes.map((c) => [c.id, c]));
    const ids = [...byId.keys()];
    const keys = ids.map((id) => [tracked.kind, id]);
    const existing = (await outbox.getMany({ trans, keys })) as (OutboxEntry | undefined)[];
    const marks = (await meta.getMany({ trans, keys: ids.map((id) => markKey(tracked.kind, id)) })) as (
      | { value?: { clock?: unknown; own?: unknown } }
      | undefined
    )[];
    // The newest version of the record known here: pulled (`clock`) or pushed (`own`)
    const seen = (i: number) => {
      const { clock, own } = marks[i]?.value ?? {};
      const newest = Math.max(typeof clock === 'number' ? clock : 0, typeof own === 'number' ? own : 0);
      return newest > 0 ? newest : undefined;
    };
    const values = [...byId.values()].map((c, i) => coalesce(existing[i], tracked.kind, c, now, seen(i)));
    const res = await outbox.mutate({ trans, type: 'put', values });
    if (res.numFailures) throw res.failures[0];
  }

  /** Changes for an add/put, plus the values to write (pages get a fresh updatedAt). */
  function changesForWrite(req: DBCoreMutateRequest & { type: 'add' | 'put' }, stamp: Date) {
    const changes: (Change | null)[] = [];
    let values = req.values;
    const specs: ChangeSpec[] = req.values.map((_, i) =>
      req.type === 'put' ? (req.updates?.changeSpecs[i] ?? (req.changeSpec || undefined)) : undefined
    );
    let stamped = false;
    req.values.forEach((value, i) => {
      const id = extractKey(value) as string;
      const spec = specs[i];
      const fields = spec ? topLevelFields(spec) : null; // null: the whole record may have changed
      const synced = fields ? fields.filter((f) => !tracked.localOnly.includes(f)) : null;
      if (!syncsId(id) || (synced && synced.length === 0)) {
        changes.push(null);
        return;
      }
      const fileChanged = tracked.file
        ? synced
          ? synced.includes(tracked.file)
          : value[tracked.file] != null
        : false;
      changes.push({ id, op: 'upsert', fileChanged });
      // Every synced change to a page bumps its updatedAt, unless the write sets it itself
      if (tracked.kind === 'page' && !(spec ? 'updatedAt' in spec : value.updatedAt instanceof Date)) {
        if (!stamped) values = [...values];
        stamped = true;
        (values as unknown[])[i] = { ...value, updatedAt: stamp };
        if (spec && req.type === 'put' && req.updates) specs[i] = { ...spec, updatedAt: stamp };
      }
    });
    let request: DBCoreMutateRequest = req;
    if (stamped && req.type === 'put') {
      request = {
        ...req,
        values,
        ...(req.changeSpec ? { changeSpec: { ...req.changeSpec, updatedAt: stamp } } : {}),
        ...(req.updates ? { updates: { keys: req.updates.keys, changeSpecs: specs as Record<string, unknown>[] } } : {}),
      };
    } else if (stamped) {
      request = { ...req, values };
    }
    return { changes, request };
  }

  return {
    ...down,
    async mutate(req) {
      if (!isTracked(req.trans)) return down.mutate(req);
      const now = Date.now();

      if (req.type === 'add' || req.type === 'put') {
        const { changes, request } = changesForWrite(req, new Date(now));
        const res = await down.mutate(request);
        await enqueue(
          req.trans,
          changes.filter((c, i): c is Change => c !== null && !res.failures[i]),
          now
        );
        return res;
      }

      let keys: string[];
      if (req.type === 'delete') {
        keys = req.keys;
      } else {
        // deleteRange (e.g. table.clear()): find what's about to go
        const found = await down.query({
          trans: req.trans,
          values: false,
          query: { index: down.schema.primaryKey, range: req.range },
        });
        keys = found.result as string[];
      }
      const res = await down.mutate(req);
      const changes = keys
        .filter((id, i) => syncsId(id) && !(req.type === 'delete' && res.failures[i]))
        .map((id): Change => ({ id, op: 'delete', fileChanged: false }));
      await enqueue(req.trans, changes, now);
      return res;
    },
  };
}

export const syncTrackingMiddleware: Middleware<DBCore> = {
  stack: 'dbcore',
  name: 'SyncTracking',
  create(down) {
    // Stacks are also built for the older schemas an upgrade passes through
    const names = down.schema.tables.map((t) => t.name);
    if (!names.includes(OUTBOX_TABLE) || !names.includes(META_TABLE)) return down;
    return {
      ...down,
      transaction(stores, mode, options) {
        // Every read-write transaction on a synced table also writes the outbox and reads the
        // records' sync markers (for the write clock)
        if (mode === 'readwrite' && stores.some((s) => s in TRACKED_TABLES)) {
          const extra = [OUTBOX_TABLE, META_TABLE].filter((t) => !stores.includes(t));
          if (extra.length > 0) stores = [...stores, ...extra];
        }
        return down.transaction(stores, mode, options);
      },
      table(name) {
        const table = down.table(name);
        const tracked = TRACKED_TABLES[name];
        return tracked ? trackTable(table, down.table(OUTBOX_TABLE), down.table(META_TABLE), tracked) : table;
      },
    };
  },
};
