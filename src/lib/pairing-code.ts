import { decodePairingPublicKey, encodePairingPublicKey } from '@/lib/crypto';

/*
 * The text inside a pairing QR code, and nothing else (no network, no React).
 *
 *   qs1:<requestId>:<publicKey>
 *
 *   qs1        format version; a newer app may show qs2, which this one refuses as "update"
 *   requestId  22–64 URL-safe base64 chars: the `pairing_requests.id` the new device created
 *   publicKey  87 base64url chars: the new device's one-time P-256 key (65 bytes, 0x04…)
 *
 * Only public values: never put the vault key, the recovery key or anything else secret in
 * here. The public key must reach the unlocked device through this QR code and never through
 * the server (see lib/crypto/pairing.ts), so parsing is strict.
 */

export const PAIRING_CODE_VERSION = 'qs1';
const VERSION_PATTERN = /^qs(\d{1,3})$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
const PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{87}$/;
/** Longer than any valid code by a margin; anything bigger isn't worth splitting. */
const MAX_CODE_LENGTH = 200;
/** 18 random bytes -> 24 base64url chars (144 bits). */
const REQUEST_ID_BYTES = 18;

export interface PairingCode {
  requestId: string;
  /** Raw uncompressed P-256 point, 65 bytes. */
  publicKey: Uint8Array;
}

export type PairingCodeErrorCode = 'invalid-code' | 'unsupported-version';

export const PAIRING_CODE_MESSAGES: Record<PairingCodeErrorCode, string> = {
  'invalid-code':
    "That isn't a QuickScan pairing code. On the new device, open Settings → Sync → Scan from another device.",
  'unsupported-version': 'That code is from a newer version of QuickScan. Update the app on this device and try again.',
};

export class PairingCodeError extends Error {
  readonly code: PairingCodeErrorCode;

  constructor(code: PairingCodeErrorCode, options?: { cause?: unknown }) {
    super(PAIRING_CODE_MESSAGES[code], options);
    this.name = 'PairingCodeError';
    this.code = code;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A fresh random request id (24 URL-safe chars). */
export function createPairingRequestId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(REQUEST_ID_BYTES)));
}

export function isValidPairingRequestId(id: string): boolean {
  return REQUEST_ID_PATTERN.test(id);
}

export function formatPairingCode({ requestId, publicKey }: PairingCode): string {
  if (!isValidPairingRequestId(requestId)) throw new PairingCodeError('invalid-code');
  return `${PAIRING_CODE_VERSION}:${requestId}:${encodePairingPublicKey(publicKey)}`;
}

/**
 * Parse scanned text strictly: exact version prefix, exactly three fields, id length and
 * charset, and a 65-byte uncompressed point. Whether the point is on the curve is checked
 * when sealing (WebCrypto import). Throws `PairingCodeError`.
 */
export function parsePairingCode(text: string): PairingCode {
  if (typeof text !== 'string' || text.length > MAX_CODE_LENGTH) throw new PairingCodeError('invalid-code');
  const parts = text.split(':');
  const version = VERSION_PATTERN.exec(parts[0] ?? '');
  if (!version) throw new PairingCodeError('invalid-code');
  if (parts[0] !== PAIRING_CODE_VERSION) {
    throw new PairingCodeError(Number(version[1]) > 1 ? 'unsupported-version' : 'invalid-code');
  }
  if (parts.length !== 3) throw new PairingCodeError('invalid-code');
  const [, requestId, key] = parts;
  if (!isValidPairingRequestId(requestId) || !PUBLIC_KEY_PATTERN.test(key)) {
    throw new PairingCodeError('invalid-code');
  }
  let publicKey: Uint8Array;
  try {
    publicKey = decodePairingPublicKey(key);
  } catch (cause) {
    throw new PairingCodeError('invalid-code', { cause });
  }
  // Base64url with non-zero trailing bits decodes to the same bytes as the canonical form;
  // insist on the canonical text so each key has exactly one code.
  if (encodePairingPublicKey(publicKey) !== key) throw new PairingCodeError('invalid-code');
  return { requestId, publicKey };
}

const FINGERPRINT_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, as the recovery key

/**
 * A short code both screens show ("K7Q-F2X", 30 bits of SHA-256 over the QR text), so the
 * person can see the phone they scanned is the one they meant to add.
 */
export async function pairingFingerprint(code: PairingCode): Promise<string> {
  const text = formatPairingCode(code);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let bits = 0;
  for (let i = 0; i < 4; i++) bits = (bits << 8) | hash[i];
  let out = '';
  for (let i = 0; i < 6; i++) out += FINGERPRINT_ALPHABET[(bits >>> (27 - i * 5)) & 31];
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}
