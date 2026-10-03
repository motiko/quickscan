import { CryptoError } from './errors';
import { FORMAT_V1, IV_BYTES, concatBytes, randomBytes, splitEnvelope, type Bytes } from './encoding';

/*
 * AES-256-GCM envelope shared by records, files, wrapped keys and pairing:
 *
 *   0x01 || [header] || iv (12 random bytes) || ciphertext || tag (16 bytes)
 *
 * (Record payloads that authenticate their sync clock use 0x02 with an 8-byte header; see
 * records.ts.)
 *
 * A fresh random 96-bit IV per encryption. With random IVs the usual NIST limit is 2^32
 * encryptions per key, far beyond what one user's vault produces.
 */

export async function sealEnvelope(
  key: CryptoKey,
  aad: Bytes,
  plaintext: Bytes,
  header?: Uint8Array,
  version: number = FORMAT_V1
): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plaintext);
  return concatBytes(Uint8Array.of(version), header ?? new Uint8Array(0), iv, new Uint8Array(ct));
}

export async function openEnvelope(
  key: CryptoKey,
  aad: Bytes,
  data: Uint8Array,
  headerBytes = 0,
  version: number = FORMAT_V1
): Promise<Bytes> {
  const { iv, body } = splitEnvelope(data, headerBytes, version);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, body));
  } catch (cause) {
    throw authFailed(cause);
  }
}

/** Wrap an (extractable) AES key as an envelope, without its raw bytes ever reaching JS. */
export async function wrapKeyEnvelope(key: CryptoKey, kek: CryptoKey, aad: Bytes, header?: Uint8Array): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  const ct = await crypto.subtle.wrapKey('raw', key, kek, { name: 'AES-GCM', iv, additionalData: aad });
  return concatBytes(Uint8Array.of(FORMAT_V1), header ?? new Uint8Array(0), iv, new Uint8Array(ct));
}

/** Unwrap an envelope from `wrapKeyEnvelope` into an AES-256-GCM key. */
export async function unwrapKeyEnvelope(
  data: Uint8Array,
  kek: CryptoKey,
  aad: Bytes,
  extractable: boolean,
  headerBytes = 0
): Promise<CryptoKey> {
  const { iv, body } = splitEnvelope(data, headerBytes);
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      body,
      kek,
      { name: 'AES-GCM', iv, additionalData: aad },
      { name: 'AES-GCM', length: 256 },
      extractable,
      ['encrypt', 'decrypt']
    );
  } catch (cause) {
    throw authFailed(cause);
  }
}

function authFailed(cause: unknown): CryptoError {
  return new CryptoError('auth-failed', 'Decryption failed: wrong key or tampered data', { cause });
}
