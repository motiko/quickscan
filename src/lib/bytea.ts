/*
 * Postgres `bytea` through PostgREST (supabase-js) travels as text in hex format, both ways:
 *
 *   write: send the string '\x' + lowercase hex      e.g. '\x0102ff'
 *   read:  PostgREST returns the same '\x…' string   (never a Uint8Array or base64)
 *
 * Verified against local Supabase. Both shortcuts silently corrupt data instead of failing:
 * hex without the '\x' prefix is stored as the bytes of the text itself, and a Uint8Array
 * is JSON-serialized to '{"0":1,…}' and stored as those characters.
 */

const HEX = /^[0-9a-f]*$/i;

export function toBytea(bytes: Uint8Array): string {
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `\\x${hex}`;
}

export function fromBytea(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string' || !value.startsWith('\\x')) {
    throw new TypeError('Expected a bytea hex string (\\x…)');
  }
  const hex = value.slice(2);
  if (hex.length % 2 !== 0 || !HEX.test(hex)) throw new TypeError('Malformed bytea hex string');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
