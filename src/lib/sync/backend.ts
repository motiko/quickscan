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
}

export class SyncBackendError extends Error {
  /** True when the request never reached the server (offline, DNS, CORS, aborted). */
  readonly network: boolean;

  constructor(message: string, options: { cause?: unknown; network?: boolean } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SyncBackendError';
    this.network = options.network ?? false;
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
    };
  };
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

function fail(what: string, error: SupabaseErrorLike): never {
  throw new SyncBackendError(`${what}: ${error.message}`, { cause: error, network: isNetworkError(error) });
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
  };
}
