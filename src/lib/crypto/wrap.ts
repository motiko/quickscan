import { unwrapKeyEnvelope, wrapKeyEnvelope } from './aead';
import { CryptoError } from './errors';
import { encodeContext, fromBase64, randomBytes, toBase64, toBytes, type Bytes } from './encoding';

/*
 * Wrapping the vault key with a high-entropy secret, for the `vault_keys` table
 * (`wrapped_key bytea`, `params jsonb`). One path for every method: the recovery key
 * (16 random bytes) now, a WebAuthn PRF output (32 bytes, method 'passkey') later.
 *
 *   kek         = HKDF-SHA256(ikm = secret, salt = params.salt (32 random bytes),
 *                             info = encodeContext('quickscan/vault-wrap', [method]))
 *   wrapped_key = 0x01 || iv (12) || AES-256-GCM(kek, iv, aad, rawVaultKey (32)) || tag (16)   — 61 bytes
 *   aad         = encodeContext('quickscan/vault-key', [userId, method])
 *   params      = {"v":1,"method":…,"kdf":"HKDF-SHA256","salt":"<base64>","alg":"AES-256-GCM"}
 *
 * Why HKDF and not a slow password KDF (PBKDF2/Argon2): the secrets are machine-generated
 * and carry at least 128 bits of entropy, so there is nothing to brute-force; slowing the
 * KDF only helps low-entropy, human-chosen passwords. HKDF gives domain separation (the
 * method is in `info`) and the random salt makes every wrap use a fresh KEK. Never feed a
 * user-chosen password, or the emailed sign-in code, into this path.
 */

export type WrapMethod = 'recovery' | 'passkey';

export interface WrapParams {
  v: 1;
  method: WrapMethod;
  kdf: 'HKDF-SHA256';
  /** Base64 HKDF salt, 32 bytes. */
  salt: string;
  alg: 'AES-256-GCM';
}

export interface WrappedVaultKey {
  wrappedKey: Bytes;
  params: WrapParams;
}

/** Secrets shorter than this are refused: below 128 bits, HKDF would be the wrong KDF. */
export const MIN_SECRET_BYTES = 16;
const SALT_BYTES = 32;

async function deriveKek(secret: Uint8Array, salt: Bytes, method: WrapMethod): Promise<CryptoKey> {
  if (secret.length < MIN_SECRET_BYTES) {
    throw new RangeError(`Wrapping secret must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  const ikm = await crypto.subtle.importKey('raw', toBytes(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encodeContext('quickscan/vault-wrap', [method]) },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

function wrapAad(userId: string, method: WrapMethod): Bytes {
  return encodeContext('quickscan/vault-key', [userId, method]);
}

/**
 * Wrap the vault key for storage on the server. `vaultKey` must be extractable — a
 * transient key from `generateVaultKey`, `loadTransferableVaultKey` or an unwrap; never
 * the non-extractable key from `loadVaultKey`.
 */
export async function wrapVaultKey(
  vaultKey: CryptoKey,
  secret: Uint8Array,
  opts: { userId: string; method: WrapMethod }
): Promise<WrappedVaultKey> {
  const salt = randomBytes(SALT_BYTES);
  const kek = await deriveKek(secret, salt, opts.method);
  const wrappedKey = await wrapKeyEnvelope(vaultKey, kek, wrapAad(opts.userId, opts.method));
  return {
    wrappedKey,
    params: { v: 1, method: opts.method, kdf: 'HKDF-SHA256', salt: toBase64(salt), alg: 'AES-256-GCM' },
  };
}

/**
 * Recover the vault key from a `vault_keys` row. Returns an **extractable** key: hand it to
 * `storeVaultKey` right away and drop it. Throws `CryptoError` for a wrong secret, a
 * tampered row, a row of another user, or params this build doesn't understand.
 */
export async function unwrapVaultKey(
  row: { wrappedKey: Uint8Array; params: unknown },
  secret: Uint8Array,
  opts: { userId: string }
): Promise<CryptoKey> {
  const params = parseWrapParams(row.params);
  const kek = await deriveKek(secret, fromBase64(params.salt), params.method);
  return unwrapKeyEnvelope(row.wrappedKey, kek, wrapAad(opts.userId, params.method), true);
}

function parseWrapParams(raw: unknown): WrapParams {
  const p = (raw ?? {}) as Partial<WrapParams>;
  if (p.v !== 1) throw new CryptoError('unsupported-version', 'Unsupported vault key params version');
  if (p.kdf !== 'HKDF-SHA256' || p.alg !== 'AES-256-GCM' || (p.method !== 'recovery' && p.method !== 'passkey')) {
    throw new CryptoError('malformed', 'Unsupported vault key params');
  }
  if (typeof p.salt !== 'string' || fromBase64(p.salt).length !== SALT_BYTES) {
    throw new CryptoError('malformed', 'Invalid vault key salt');
  }
  return p as WrapParams;
}
