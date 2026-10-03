import { openEnvelope, sealEnvelope } from './aead';
import { CryptoError } from './errors';
import { encodeContext, fromBase64, toBase64, type Bytes } from './encoding';

/*
 * Record payloads (the `records.payload bytea` column):
 *
 *   0x01 || iv (12) || AES-256-GCM(vaultKey, iv, aad, utf8(json)) || tag (16)
 *   aad = encodeContext('quickscan/record', [userId, kind, id])
 *
 * The AAD binds the ciphertext to its row, so the server can't move it to another record,
 * kind or user. `key_version` is a plain column, not part of the AAD: a wrong version only
 * picks the wrong key, which fails authentication anyway.
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

export function recordAad({ userId, kind, id }: RecordContext): Bytes {
  return encodeContext('quickscan/record', [userId, kind, id]);
}

export async function encryptRecord(key: CryptoKey, ctx: RecordContext, value: unknown): Promise<Bytes> {
  const json = JSON.stringify(toJsonSafe(value, '$'));
  return sealEnvelope(key, recordAad(ctx), new TextEncoder().encode(json));
}

/** Throws `CryptoError` on a wrong key, tampering, a mismatched context or a truncated payload. */
export async function decryptRecord<T = unknown>(key: CryptoKey, ctx: RecordContext, payload: Uint8Array): Promise<T> {
  const plain = await openEnvelope(key, recordAad(ctx), payload);
  try {
    return fromJsonSafe(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))) as T;
  } catch (cause) {
    throw new CryptoError('malformed', 'Decrypted record is not valid', { cause });
  }
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
