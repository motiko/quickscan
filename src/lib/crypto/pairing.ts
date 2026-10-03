import { unwrapKeyEnvelope, wrapKeyEnvelope } from './aead';
import { CryptoError } from './errors';
import { encodeContext, fromBase64, toBase64, toBytes, type Bytes } from './encoding';

/*
 * Pairing: an unlocked device hands the vault key to a new device, ECIES-style.
 *
 * 1. New device: `createPairingKeyPair()` — a one-time ECDH P-256 key pair (P-256 because
 *    iOS Safari's WebCrypto supports it; X25519 isn't everywhere yet). The private key is
 *    non-extractable and stays in memory. The public key goes into the QR code as
 *    `encodePairingPublicKey(pub)`: 65-byte uncompressed SEC1 point -> 87 base64url chars.
 * 2. Unlocked device: `sealVaultKeyForPairing(transientVaultKey, pub, requestId)`.
 * 3. New device: `openPairedVaultKey(pair, sealed, requestId)` -> extractable vault key for
 *    `storeVaultKey`.
 *
 * Sealed layout (126 bytes):
 *   0x01 || ephemeralPub (65) || iv (12) || AES-256-GCM(k, iv, aad, rawVaultKey (32)) || tag (16)
 *   shared = ECDH(ephemeralPriv, recipientPub)                      (32 bytes)
 *   k      = HKDF-SHA256(ikm = shared, salt = empty,
 *                        info = encodeContext('quickscan/pairing-kdf', [requestId, ephemeralPub, recipientPub]))
 *   aad    = encodeContext('quickscan/pairing', [requestId])
 *
 * ECIES doesn't authenticate the sender: anyone who knows the recipient's public key can
 * seal *some* key to it. The public key must therefore reach the unlocked device only
 * through the QR code (out of band), never through the server — otherwise the server could
 * seal a key of its own choosing and read everything the new device uploads.
 */

export const PAIRING_PUBLIC_KEY_BYTES = 65;
const EC = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface PairingKeyPair {
  /** Non-extractable ECDH private key; keep in memory only, for one pairing. */
  privateKey: CryptoKey;
  /** Raw uncompressed P-256 point (65 bytes). */
  publicKey: Bytes;
}

export async function createPairingKeyPair(): Promise<PairingKeyPair> {
  const pair = (await crypto.subtle.generateKey(EC, false, ['deriveBits'])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { privateKey: pair.privateKey, publicKey };
}

/** Compact text for the QR code: base64url of the raw public key. */
export function encodePairingPublicKey(publicKey: Uint8Array): string {
  return toBase64(publicKey, true);
}

/** Inverse of `encodePairingPublicKey`; checks the length and point format (not the curve). */
export function decodePairingPublicKey(text: string): Bytes {
  const bytes = fromBase64(text.trim());
  if (bytes.length !== PAIRING_PUBLIC_KEY_BYTES || bytes[0] !== 0x04) {
    throw new CryptoError('malformed', 'Invalid pairing public key');
  }
  return bytes;
}

async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== PAIRING_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw new CryptoError('malformed', 'Invalid pairing public key');
  }
  try {
    return await crypto.subtle.importKey('raw', toBytes(raw), EC, false, []);
  } catch (cause) {
    throw new CryptoError('malformed', 'Invalid pairing public key', { cause });
  }
}

async function deriveSealKey(
  privateKey: CryptoKey,
  peerPublic: CryptoKey,
  requestId: string,
  ephemeralPub: Uint8Array,
  recipientPub: Uint8Array
): Promise<CryptoKey> {
  const shared = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPublic }, privateKey, 256);
  const ikm = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: encodeContext('quickscan/pairing-kdf', [requestId, ephemeralPub, recipientPub]),
    },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['wrapKey', 'unwrapKey']
  );
}

/**
 * Seal the vault key to a new device's public key. `vaultKey` must be the transient
 * extractable key from `loadTransferableVaultKey`.
 */
export async function sealVaultKeyForPairing(
  vaultKey: CryptoKey,
  recipientPublicKey: Uint8Array,
  requestId: string
): Promise<Bytes> {
  const recipient = await importPublicKey(recipientPublicKey);
  const eph = (await crypto.subtle.generateKey(EC, false, ['deriveBits'])) as CryptoKeyPair;
  const ephPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const k = await deriveSealKey(eph.privateKey, recipient, requestId, ephPub, recipientPublicKey);
  return wrapKeyEnvelope(vaultKey, k, encodeContext('quickscan/pairing', [requestId]), ephPub);
}

/**
 * Open a sealed vault key on the new device. Returns an **extractable** key for
 * `storeVaultKey`. Throws `CryptoError` for the wrong key pair, the wrong request id or
 * tampered / truncated data.
 */
export async function openPairedVaultKey(pair: PairingKeyPair, sealed: Uint8Array, requestId: string): Promise<CryptoKey> {
  if (sealed.length < 1 + PAIRING_PUBLIC_KEY_BYTES) throw new CryptoError('malformed', 'Sealed key is too short');
  if (sealed[0] !== 0x01) throw new CryptoError('unsupported-version', `Unsupported pairing format ${sealed[0]}`);
  const ephPub = sealed.slice(1, 1 + PAIRING_PUBLIC_KEY_BYTES);
  const eph = await importPublicKey(ephPub);
  const k = await deriveSealKey(pair.privateKey, eph, requestId, ephPub, pair.publicKey);
  return unwrapKeyEnvelope(sealed, k, encodeContext('quickscan/pairing', [requestId]), true, PAIRING_PUBLIC_KEY_BYTES);
}
