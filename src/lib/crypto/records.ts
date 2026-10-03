import { openEnvelope, sealEnvelope } from './aead';
import { CryptoError } from './errors';
import { encodeContext, fromBase64, FORMAT_V1, FORMAT_V2, toBase64, type Bytes } from './encoding';

/*
 * Record payloads (the `records.payload bytea` column). Two formats; the app writes v2.
 *
 * v2 — also authenticates the sync clock:
 *   0x02 || u64be(updatedAtMs) (8) || iv (12) || AES-256-GCM(vaultKey, iv, aad, utf8(json)) || tag (16)
 *   aad = encodeContext('quickscan/record',
 *           [userId, kind, id, u64be(updatedAtMs), deviceId, deleted ? '1' : '0'], version 0x02)
 *
 * v1 — older payloads; they still decrypt, but are no longer written:
 *   0x01 || iv (12) || AES-256-GCM(vaultKey, iv, aad, utf8(json)) || tag (16)
 *   aad = encodeContext('quickscan/record', [userId, kind, id])
 *
 * The AAD binds the ciphertext to its row, so the server can't move it to another record,
 * kind or user. v2 also binds the last-write-wins clock the writing device sent, its device
 * id and the deletion flag, so the server can't re-date an old version (a replay) or
 * attribute it to another device. The clock travels in the clear in the 8-byte header and is
 * authenticated through the AAD: the row's own `updated_at` can't be what's authenticated,
 * because `upsert_records` may lower it (it clamps to now() + 5 minutes). `openRecord` returns
 * the authenticated clock and the sync engine accepts a row clock at or below it, never above
 * (see engine.ts). Tombstones carry no payload (a schema constraint), so they can't be
 * authenticated; a payload is always sealed with deleted = '0'.
 *
 * `key_version` is a plain column, not part of the AAD: a wrong version only picks the wrong
 * key, which fails authentication anyway.
 *
 * Serialization is JSON with three tagged forms, so values survive the round trip:
 *   Date        -> {"$date": <epoch ms>}
 *   Uint8Array  -> {"$bytes": "<base64>"}
 *   object with any key starting with "$" -> {"$obj": {…}} (escapes look-alikes)
 * Everything else is plain JSON. Blobs are rejected (encrypt them with files.ts and store a
 * file id in the record), as are Maps, Sets, class instances, bigint, functions, symbols,
 * NaN/Infinity and invalid Dates. `undefined` object properties are dropped, like JSON.
 */

export interface RecordContext {
  userId: string;
  /** Sync kind ('document', 'page', 'folder', 'signature', 'settings'). */
  kind: string;
  id: string;
}

/** The row metadata a v2 payload authenticates. */
export interface RecordVersion {
  /** The last-write-wins clock the writer sent (epoch ms, integer). */
  updatedAt: number;
  deviceId: string;
  deleted: boolean;
}

export interface OpenedRecord<T = unknown> {
  value: T;
  format: 1 | 2;
  /** v2 only: the authenticated clock, as the writing device sent it. */
  updatedAt?: number;
}

const CLOCK_BYTES = 8;

function clockBytes(ms: number): Uint8Array {
  if (!Number.isSafeInteger(ms) || ms < 0) throw new TypeError(`Invalid record clock ${ms}`);
  const out = new Uint8Array(CLOCK_BYTES);
  const view = new DataView(out.buffer);
  view.setUint32(0, Math.floor(ms / 2 ** 32));
  view.setUint32(4, ms % 2 ** 32);
  return out;
}

function readClock(data: Uint8Array): number {
  const view = new DataView(data.buffer, data.byteOffset + 1, CLOCK_BYTES);
  return view.getUint32(0) * 2 ** 32 + view.getUint32(4);
}

export function recordAad({ userId, kind, id }: RecordContext): Bytes {
  return encodeContext('quickscan/record', [userId, kind, id]);
}

export function recordAadV2({ userId, kind, id }: RecordContext, version: RecordVersion): Bytes {
  return encodeContext(
    'quickscan/record',
    [userId, kind, id, clockBytes(version.updatedAt), version.deviceId, version.deleted ? '1' : '0'],
    FORMAT_V2
  );
}

const encodeValue = (value: unknown) => new TextEncoder().encode(JSON.stringify(toJsonSafe(value, '$')));

/**
 * Encrypt a record. With `version` (what the sync engine always passes) the payload is v2 and
 * authenticates that clock, device id and deletion flag; without it, a legacy v1 payload.
 */
export async function encryptRecord(
  key: CryptoKey,
  ctx: RecordContext,
  value: unknown,
  version?: RecordVersion
): Promise<Bytes> {
  if (!version) return sealEnvelope(key, recordAad(ctx), encodeValue(value));
  return sealEnvelope(key, recordAadV2(ctx, version), encodeValue(value), clockBytes(version.updatedAt), FORMAT_V2);
}

/**
 * Decrypt a v1 or v2 payload. A v2 payload needs the row's `deviceId` and `deleted` (its clock
 * comes from the header). Throws `CryptoError` on a wrong key, tampering, a mismatched
 * context or row, or a truncated payload.
 */
export async function openRecord<T = unknown>(
  key: CryptoKey,
  ctx: RecordContext,
  payload: Uint8Array,
  row?: Pick<RecordVersion, 'deviceId' | 'deleted'>
): Promise<OpenedRecord<T>> {
  let plain: Bytes;
  let updatedAt: number | undefined;
  if (payload[0] === FORMAT_V2) {
    if (!row) throw new CryptoError('malformed', 'A v2 record needs its row to be verified');
    if (payload.length < 1 + CLOCK_BYTES) throw new CryptoError('malformed', 'Encrypted data is too short');
    updatedAt = readClock(payload);
    plain = await openEnvelope(key, recordAadV2(ctx, { updatedAt, ...row }), payload, CLOCK_BYTES, FORMAT_V2);
  } else {
    plain = await openEnvelope(key, recordAad(ctx), payload, 0, FORMAT_V1);
  }
  let value: T;
  try {
    value = fromJsonSafe(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))) as T;
  } catch (cause) {
    throw new CryptoError('malformed', 'Decrypted record is not valid', { cause });
  }
  return updatedAt === undefined ? { value, format: 1 } : { value, format: 2, updatedAt };
}

/** `openRecord` without the format details. */
export async function decryptRecord<T = unknown>(
  key: CryptoKey,
  ctx: RecordContext,
  payload: Uint8Array,
  row?: Pick<RecordVersion, 'deviceId' | 'deleted'>
): Promise<T> {
  return (await openRecord<T>(key, ctx, payload, row)).value;
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function toJsonSafe(value: unknown, path: string): Json {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Cannot encrypt non-finite number at ${path}`);
    return value;
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isNaN(ms)) throw new TypeError(`Cannot encrypt invalid Date at ${path}`);
    return { $date: ms };
  }
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (Array.isArray(value)) return value.map((v, i) => (v === undefined ? null : toJsonSafe(v, `${path}[${i}]`)));
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      const name = (value as object).constructor?.name ?? 'object';
      throw new TypeError(`Cannot encrypt ${name} at ${path}${name === 'Blob' ? ' (use encryptFile)' : ''}`);
    }
    const out: { [key: string]: Json } = {};
    let escape = false;
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (k.startsWith('$')) escape = true;
      setOwn(out, k, toJsonSafe(v, `${path}.${k}`));
    }
    return escape ? { $obj: out } : out;
  }
  throw new TypeError(`Cannot encrypt ${typeof value} at ${path}`);
}

function fromJsonSafe(value: Json): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromJsonSafe);
  const keys = Object.keys(value);
  if (keys.length === 1) {
    const [k] = keys;
    const v = value[k];
    if (k === '$date' && typeof v === 'number') return new Date(v);
    if (k === '$bytes' && typeof v === 'string') return fromBase64(v);
    if (k === '$obj' && v !== null && typeof v === 'object' && !Array.isArray(v)) return decodeObject(v);
  }
  if (keys.some((k) => k.startsWith('$'))) throw new Error('Unescaped $-key in record');
  return decodeObject(value);
}

function decodeObject(obj: { [key: string]: Json }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) setOwn(out, k, fromJsonSafe(v));
  return out;
}

/** Plain assignment, except that a "__proto__" key stays data instead of setting the prototype. */
function setOwn(obj: object, key: string, value: unknown) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}
