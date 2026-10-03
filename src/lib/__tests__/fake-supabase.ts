import { fromBase64 } from '@/lib/crypto/encoding';
import { encryptFile, encryptRecord } from '@/lib/crypto';
import type { SupabaseLike } from '@/lib/sync/backend';
import type { SyncKind } from '@/lib/outbox';

/*
 * In-memory stand-in for the Supabase project: `upsert_records` with the migration's
 * last-write-wins rules, the pull query (RLS-scoped to one user), and the `vault` bucket
 * (insert-only, owner's folder only). Wire formats match PostgREST: bytea as `\x` hex,
 * timestamptz with microseconds and `+00:00`.
 */

export interface StoredRow {
  userId: string;
  kind: SyncKind;
  id: string;
  seq: number;
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
  keyVersion: number;
  payload: Uint8Array | null;
  files: string[];
}

interface WireInput {
  kind: SyncKind;
  id: string;
  updated_at: string;
  device_id: string;
  deleted?: boolean;
  key_version?: number;
  payload?: string | null;
  files?: string[];
}

const toHex = (bytes: Uint8Array) => '\\x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const pgTimestamp = (ms: number) => new Date(ms).toISOString().replace('Z', '000+00:00');
const gt = (a: StoredRow | WireLike, b: StoredRow | WireLike) =>
  a.updatedAt !== b.updatedAt ? a.updatedAt > b.updatedAt : a.deviceId > b.deviceId;

type WireLike = { updatedAt: number; deviceId: string };

export class FakeSupabase {
  rows = new Map<string, StoredRow>();
  objects = new Map<string, Blob>();
  seq = 0;
  /** Requests made, for assertions. */
  log: string[] = [];
  /** Make the next N uploads fail (non-network error). */
  failUploads = 0;
  /** Make pulls with `seq > n` fail with a network error. */
  failPullAfter: number | undefined;
  /** Simulated server clock (epoch ms) for the +5 min clamp. */
  now = () => Date.now();

  constructor(public userId: string) {}

  private key(userId: string, kind: string, id: string) {
    return `${userId}|${kind}|${id}`;
  }

  /** Server-side write, as `upsert_records` does it. Returns true when written. */
  write(input: Omit<StoredRow, 'seq' | 'userId'>, userId = this.userId): boolean {
    const k = this.key(userId, input.kind, input.id);
    const incoming = { ...input, updatedAt: Math.min(input.updatedAt, this.now() + 5 * 60_000) };
    const stored = this.rows.get(k);
    if (stored && !gt(incoming, stored)) return false;
    this.rows.set(k, {
      ...incoming,
      userId,
      seq: ++this.seq,
      payload: incoming.deleted ? null : incoming.payload,
      files: incoming.deleted ? [] : incoming.files,
    });
    return true;
  }

  rpc(fn: string, args: Record<string, unknown>) {
    this.log.push(`rpc:${fn}`);
    if (fn !== 'upsert_records') return Promise.resolve({ data: null, error: { message: `unknown function ${fn}` } });
    const input = args.rows as WireInput[];
    if (input.length > 500) return Promise.resolve({ data: null, error: { message: 'at most 500 rows per call' } });
    // Newest per (kind, id) only
    const newest = new Map<string, WireInput & WireLike>();
    for (const r of input) {
      const item = { ...r, updatedAt: Date.parse(r.updated_at), deviceId: r.device_id };
      const prev = newest.get(`${r.kind}|${r.id}`);
      if (!prev || gt(item, prev)) newest.set(`${r.kind}|${r.id}`, item);
    }
    const rejected = [];
    for (const r of newest.values()) {
      const written = this.write({
        kind: r.kind,
        id: r.id,
        updatedAt: r.updatedAt,
        deviceId: r.deviceId,
        deleted: r.deleted ?? false,
        keyVersion: r.key_version ?? 1,
        payload: r.payload ? fromBase64(r.payload) : null,
        files: r.files ?? [],
      });
      const stored = this.rows.get(this.key(this.userId, r.kind, r.id))!;
      if (!written && gt(stored, r)) {
        rejected.push({
          kind: stored.kind,
          id: stored.id,
          seq: stored.seq,
          updated_at: pgTimestamp(stored.updatedAt),
          device_id: stored.deviceId,
        });
      }
    }
    return Promise.resolve({ data: rejected, error: null });
  }

  from(table: string) {
    const filters: { eq: [string, unknown][]; gt: [string, number][]; limit: number } = { eq: [], gt: [], limit: 1000 };
    const run = () => {
      const after = filters.gt.find(([c]) => c === 'seq')?.[1] ?? 0;
      this.log.push(`pull:${after}`);
      if (this.failPullAfter !== undefined && after >= this.failPullAfter) {
        return { data: null, error: { message: 'TypeError: Failed to fetch' } };
      }
      const userFilter = filters.eq.find(([c]) => c === 'user_id')?.[1];
      const rows = [...this.rows.values()]
        // RLS: only the signed-in user's rows, whatever the query asks for
        .filter((r) => r.userId === this.userId && (userFilter === undefined || r.userId === userFilter))
        .filter((r) => r.seq > after)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, filters.limit)
        .map((r) => ({
          kind: r.kind,
          id: r.id,
          seq: r.seq,
          updated_at: pgTimestamp(r.updatedAt),
          device_id: r.deviceId,
          deleted: r.deleted,
          key_version: r.keyVersion,
          payload: r.payload ? toHex(r.payload) : null,
          files: r.files,
        }));
      return { data: rows, error: null };
    };
    const builder = {
      eq: (c: string, v: unknown) => (filters.eq.push([c, v]), builder),
      gt: (c: string, v: number) => (filters.gt.push([c, v]), builder),
      order: () => builder,
      limit: (n: number) => ((filters.limit = n), builder),
      then: (resolve?: (v: ReturnType<typeof run>) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve().then(run).then(resolve, reject),
    };
    if (table !== 'records') throw new Error(`unexpected table ${table}`);
    return { select: () => builder };
  }

  storage = {
    from: (bucket: string) => {
      if (bucket !== 'vault') throw new Error(`unexpected bucket ${bucket}`);
      return {
        upload: async (path: string, body: Blob, options: { upsert: boolean; contentType: string }) => {
          this.log.push(`upload:${path}`);
          if (this.failUploads > 0) {
            this.failUploads--;
            return { data: null, error: { message: 'Internal Server Error', statusCode: '500' } };
          }
          if (!path.startsWith(`${this.userId}/`)) return { data: null, error: { message: 'new row violates row-level security policy' } };
          if (options.contentType !== 'application/octet-stream') return { data: null, error: { message: 'mime type not allowed' } };
          if (this.objects.has(path) && !options.upsert) return { data: null, error: { message: 'The resource already exists' } };
          this.objects.set(path, body);
          return { data: { path }, error: null };
        },
        download: async (path: string) => {
          this.log.push(`download:${path}`);
          const blob = path.startsWith(`${this.userId}/`) ? this.objects.get(path) : undefined;
          return blob ? { data: blob, error: null } : { data: null, error: { message: 'Object not found' } };
        },
      };
    },
  };

  /** This fake as the client the sync backend expects. */
  asClient(): SupabaseLike {
    return this as unknown as SupabaseLike;
  }

  get(kind: SyncKind, id: string, userId = this.userId): StoredRow | undefined {
    return this.rows.get(this.key(userId, kind, id));
  }

  // --- "Another device" ---------------------------------------------------------------

  async remoteRecord(
    key: CryptoKey,
    opts: { kind: SyncKind; id: string; updatedAt: number; deviceId?: string; value?: unknown; deleted?: boolean; files?: string[] }
  ): Promise<void> {
    const payload = opts.deleted
      ? null
      : await encryptRecord(key, { userId: this.userId, kind: opts.kind, id: opts.id }, opts.value);
    this.write({
      kind: opts.kind,
      id: opts.id,
      updatedAt: opts.updatedAt,
      deviceId: opts.deviceId ?? 'other-device',
      deleted: opts.deleted ?? false,
      keyVersion: 1,
      payload,
      files: opts.files ?? [],
    });
  }

  async remoteFile(key: CryptoKey, fileId: string, blob: Blob): Promise<string> {
    const path = `${this.userId}/${fileId}`;
    this.objects.set(path, await encryptFile(key, { userId: this.userId, fileId }, blob));
    return path;
  }
}
