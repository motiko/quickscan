import { CryptoError } from './errors';

/*
 * Byte helpers shared by the crypto module: the envelope format, the context encoding used
 * for AES-GCM associated data and HKDF info, and base64. Nothing here is secret-dependent.
 */

/** Format byte of every envelope this module writes (record, file, wrapped key, sealed key). */
export const FORMAT_V1 = 0x01;

export const IV_BYTES = 12;
export const TAG_BYTES = 16;

/** `Uint8Array` backed by a plain `ArrayBuffer`, as WebCrypto's `BufferSource` wants. */
export type Bytes = Uint8Array<ArrayBuffer>;

const utf8 = new TextEncoder();

export function concatBytes(...parts: Uint8Array[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function randomBytes(n: number): Bytes {
  return crypto.getRandomValues(new Uint8Array(n));
}

/**
 * Unambiguous, versioned encoding of a labelled tuple, used as AES-GCM associated data and
 * as HKDF `info`:
 *
 *   0x01 || u32be(len(label)) || label || u32be(len(f1)) || f1 || u32be(len(f2)) || f2 || …
 *
 * Strings are UTF-8. Every item is length-prefixed, so different tuples can never encode to
 * the same bytes (`["ab","c"]` vs `["a","bc"]`), and the label separates purposes (a record
 * AAD can never equal a file AAD). The leading byte is the envelope format version, so the
 * version byte of a payload is authenticated too.
 */
export function encodeContext(label: string, fields: readonly (string | Uint8Array)[]): Bytes {
  const items = [label, ...fields].map((f) => (typeof f === 'string' ? utf8.encode(f) : f));
  const parts: Uint8Array[] = [Uint8Array.of(FORMAT_V1)];
  for (const item of items) {
    const len = new Uint8Array(4);
    new DataView(len.buffer).setUint32(0, item.length);
    parts.push(len, item);
  }
  return concatBytes(...parts);
}

/** Copy into a fresh `ArrayBuffer`-backed array (also accepts views into larger buffers). */
export function toBytes(data: ArrayBuffer | Uint8Array): Bytes {
  return data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data.slice(0));
}

/** Split `0x01 || iv(12) || ciphertext+tag` after checking version and minimum length. */
export function splitEnvelope(data: Uint8Array, headerBytes = 0): { header: Uint8Array; iv: Bytes; body: Bytes } {
  if (data.length < 1 + headerBytes + IV_BYTES + TAG_BYTES) {
    throw new CryptoError('malformed', 'Encrypted data is too short');
  }
  if (data[0] !== FORMAT_V1) {
    throw new CryptoError('unsupported-version', `Unsupported encryption format ${data[0]}`);
  }
  return {
    header: data.slice(1, 1 + headerBytes),
    iv: data.slice(1 + headerBytes, 1 + headerBytes + IV_BYTES),
    body: data.slice(1 + headerBytes + IV_BYTES),
  };
}

export function toBase64(bytes: Uint8Array, url = false): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  return url ? b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : b64;
}

/** Decode standard or URL-safe base64, padded or not. Throws `CryptoError('malformed')`. */
export function fromBase64(text: string): Bytes {
  let b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  b64 += '='.repeat((4 - (b64.length % 4)) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch (cause) {
    throw new CryptoError('malformed', 'Invalid base64', { cause });
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
