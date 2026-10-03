import { toBase64 } from '@/lib/crypto/encoding';
import { fromBytea } from '@/lib/bytea';
import type { SyncKind } from '@/lib/outbox';

/*
 * The server side of sync, as the engine sees it: the `upsert_records` RPC, the pull query on
 * `records`, and the private `vault` Storage bucket. Everything that crosses this boundary is
 * ciphertext plus the merge metadata (kind, id, clock, device id).
 *
 * `createSupabaseBackend` adapts a Supabase client (or anything shaped like one — the unit
 * tests pass an in-memory fake) to `SyncBackend`.
 */

/** Rows per `upsert_records` call and per pull page; the RPC refuses more than 500. */
export const SYNC_BATCH_SIZE = 500;

export const VAULT_BUCKET = 'vault';

export interface PushRow {
  kind: SyncKind;
  id: string;
  /** The last-write-wins clock (epoch ms); sent as ISO-8601. */
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
  keyVersion: number;
  /** `encryptRecord` output; null for tombstones. */
  payload: Uint8Array | null;
  /** Storage object names (`<userId>/<fileId>`) the record references. */
  files: string[];
}

export interface RemoteRow {
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

/** A pushed row the server kept its own (newer) version of. */
export interface RejectedRow {
  kind: SyncKind;
  id: string;
  seq: number;
  updatedAt: number;
  deviceId: string;
}

export interface SyncBackend {
  /** Last-write-wins upsert; returns the rejected rows only. */
  upsertRecords(rows: PushRow[]): Promise<RejectedRow[]>;
  /** The signed-in user's rows with `seq > afterSeq`, in seq order. */
  pullRecords(userId: string, afterSeq: number, limit: number): Promise<RemoteRow[]>;
  /** Upload an encrypted file; objects are immutable (never overwritten). */
  uploadFile(path: string, data: Blob): Promise<void>;
  downloadFile(path: string): Promise<Blob>;
  /** Storage object names (`<userId>/<fileId>`) referenced by live records with `seq > afterSeq`, in seq order. */
  listReferencedFiles(userId: string, afterSeq: number, limit: number): Promise<{ rows: number; lastSeq: number; files: string[] }>;
  /** One page of the objects in `vault/<userId>/`, by name. */
  listFiles(userId: string, offset: number, limit: number): Promise<StoredFile[]>;
  /** Delete objects by full name (`<userId>/<fileId>`). */
  removeFiles(paths: string[]): Promise<void>;
}

/** An object in the vault bucket, as Storage lists it. */
export interface StoredFile {
  /** Full object name, `<userId>/<fileId>`. */
  path: string;
  /** Epoch ms, server time. */
  createdAt: number;
  size: number;
}

export class SyncBackendError extends Error {
  /** True when the request never reached the server (offline, DNS, CORS, aborted). */
  readonly network: boolean;
  /** HTTP status, when the server answered (e.g. 401, 413). */
  readonly status?: number;

  constructor(message: string, options: { cause?: unknown; network?: boolean; status?: number } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SyncBackendError';
    this.network = options.network ?? false;
    this.status = options.status;
  }
}

// --- Supabase adapter --------------------------------------------------------------------

interface SupabaseErrorLike {
  message: string;
  code?: string;
  status?: number;
  statusCode?: string | number;
}

type Result<T> = PromiseLike<{ data: T | null; error: SupabaseErrorLike | null }>;

interface FilterBuilderLike<T> extends Result<T> {
  eq(column: string, value: unknown): FilterBuilderLike<T>;
  gt(column: string, value: unknown): FilterBuilderLike<T>;
  order(column: string, options?: { ascending?: boolean }): FilterBuilderLike<T>;
  limit(count: number): FilterBuilderLike<T>;
}

/** The slice of `SupabaseClient` sync uses; the real client satisfies it structurally. */
export interface SupabaseLike {
  rpc(fn: string, args: Record<string, unknown>): Result<unknown>;
  from(table: string): { select(columns: string): FilterBuilderLike<unknown[]> };
  storage: {
    from(bucket: string): {
      upload(
        path: string,
        body: Blob,
        options: { upsert: boolean; contentType: string }
      ): PromiseLike<{ data: unknown; error: SupabaseErrorLike | null }>;
      download(path: string): PromiseLike<{ data: Blob | null; error: SupabaseErrorLike | null }>;
      list(
        prefix: string,
        options: { limit: number; offset: number; sortBy: { column: string; order: 'asc' | 'desc' } }
      ): PromiseLike<{ data: StorageListEntry[] | null; error: SupabaseErrorLike | null }>;
      remove(paths: string[]): PromiseLike<{ data: unknown; error: SupabaseErrorLike | null }>;
    };
  };
}

interface StorageListEntry {
  name: string;
  /** Null for folders. */
  id: string | null;
  created_at: string | null;
  metadata: { size?: number } | null;
}

interface WireRow {
  kind: string;
  id: string;
  seq: number | string;
  updated_at: string;
  device_id: string;
  deleted?: boolean;
  key_version?: number;
  payload?: string | null;
  files?: string[] | null;
}

const PULL_COLUMNS = 'kind,id,seq,updated_at,device_id,deleted,key_version,payload,files';

function isNetworkError(error: SupabaseErrorLike | unknown): boolean {
  const message = (error as { message?: string })?.message ?? '';
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message);
}

function httpStatus(error: SupabaseErrorLike): number | undefined {
  const n = Number(error.status ?? error.statusCode);
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : undefined;
}

function fail(what: string, error: SupabaseErrorLike): never {
  throw new SyncBackendError(`${what}: ${error.message}`, {
    cause: error,
    network: isNetworkError(error),
    status: httpStatus(error),
  });
}

/** Postgres timestamptz text (microseconds, `+00:00`) to epoch ms. */
export function parseTimestamp(text: string): number {
  // Trim fractional seconds to milliseconds; Date.parse is only specified for three digits
  const normalized = text.replace(/(\.\d{3})\d+/, '$1').replace(' ', 'T');
  const ms = Date.parse(normalized);
  if (Number.isNaN(ms)) throw new SyncBackendError(`Invalid timestamp from server: ${text}`);
  return ms;
}

/** PostgREST returns bytea as `\x` + hex (see lib/bytea.ts). */
export function parseBytea(text: string | null | undefined): Uint8Array | null {
  return text == null ? null : fromBytea(text);
}

export function toWireRow(row: PushRow): Record<string, unknown> {
  return {
    kind: row.kind,
    id: row.id,
    updated_at: new Date(row.updatedAt).toISOString(),
    device_id: row.deviceId,
    deleted: row.deleted,
    key_version: row.keyVersion,
    payload: row.payload ? toBase64(row.payload) : null,
    files: row.files,
  };
}

function fromWireRow(row: WireRow): RemoteRow {
  return {
    kind: row.kind as SyncKind,
    id: row.id,
    seq: Number(row.seq),
    updatedAt: parseTimestamp(row.updated_at),
    deviceId: row.device_id,
    deleted: row.deleted ?? false,
    keyVersion: row.key_version ?? 1,
    payload: parseBytea(row.payload),
    files: row.files ?? [],
  };
}

async function call<T>(what: string, run: () => PromiseLike<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof SyncBackendError) throw cause;
    throw new SyncBackendError(`${what}: ${(cause as Error)?.message ?? String(cause)}`, {
      cause,
      network: cause instanceof TypeError || isNetworkError(cause),
    });
  }
}

export function createSupabaseBackend(client: SupabaseLike): SyncBackend {
  return {
    async upsertRecords(rows) {
      if (rows.length > SYNC_BATCH_SIZE) throw new RangeError(`At most ${SYNC_BATCH_SIZE} rows per push`);
      const { data, error } = await call('Push', () => client.rpc('upsert_records', { rows: rows.map(toWireRow) }));
      if (error) fail('Push', error);
      return ((data as WireRow[] | null) ?? []).map((r) => ({
        kind: r.kind as SyncKind,
        id: r.id,
        seq: Number(r.seq),
        updatedAt: parseTimestamp(r.updated_at),
        deviceId: r.device_id,
      }));
    },

    async pullRecords(userId, afterSeq, limit) {
      const { data, error } = await call('Pull', () =>
        client
          .from('records')
          .select(PULL_COLUMNS)
          .eq('user_id', userId)
          .gt('seq', afterSeq)
          .order('seq', { ascending: true })
          .limit(limit)
      );
      if (error) fail('Pull', error);
      return ((data as WireRow[] | null) ?? []).map(fromWireRow);
    },

    async uploadFile(path, data) {
      const { error } = await call('Upload', () =>
        client.storage.from(VAULT_BUCKET).upload(path, data, { upsert: false, contentType: 'application/octet-stream' })
      );
      if (error) fail('Upload', error);
    },

    async downloadFile(path) {
      const { data, error } = await call('Download', () => client.storage.from(VAULT_BUCKET).download(path));
      if (error) fail('Download', error);
      if (!data) throw new SyncBackendError('Download: empty response');
      return data;
    },

    async listReferencedFiles(userId, afterSeq, limit) {
      const { data, error } = await call('List references', () =>
        client
          .from('records')
          .select('seq,files')
          .eq('user_id', userId)
          .eq('deleted', false)
          .gt('seq', afterSeq)
          .order('seq', { ascending: true })
          .limit(limit)
      );
      if (error) fail('List references', error);
      const rows = (data as { seq: number | string; files: string[] | null }[] | null) ?? [];
      return {
        rows: rows.length,
        lastSeq: rows.length ? Number(rows[rows.length - 1].seq) : afterSeq,
        files: rows.flatMap((r) => r.files ?? []),
      };
    },

    async listFiles(userId, offset, limit) {
      const { data, error } = await call('List files', () =>
        client.storage.from(VAULT_BUCKET).list(userId, { limit, offset, sortBy: { column: 'name', order: 'asc' } })
      );
      if (error) fail('List files', error);
      return (data ?? [])
        .filter((o) => o.id !== null)
        .map((o) => ({
          path: `${userId}/${o.name}`,
          // Unknown age counts as brand new, so it's never deleted on a guess
          createdAt: o.created_at ? Date.parse(o.created_at) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER,
          size: o.metadata?.size ?? 0,
        }));
    },

    async removeFiles(paths) {
      if (paths.length === 0) return;
      const { error } = await call('Delete files', () => client.storage.from(VAULT_BUCKET).remove(paths));
      if (error) fail('Delete files', error);
    },
  };
}
