/**
 * Every failure of the crypto module surfaces as a `CryptoError` with a code, so callers
 * can tell "wrong key or tampered data" from "this isn't a payload at all". Messages never
 * contain key material or plaintext.
 *
 * - `auth-failed`: AES-GCM authentication failed — wrong key, a flipped bit, or the
 *   ciphertext was moved to another record / user / request (AAD mismatch). GCM can't tell
 *   these apart, and neither do we.
 * - `malformed`: too short, or not something this module produced (bad public key, bad JSON
 *   inside an authenticated payload, bad wrap params).
 * - `unsupported-version`: the leading format byte is one this build doesn't know.
 * - `invalid-recovery-key`: the recovery key doesn't parse or its checksum doesn't match.
 *   Raised before any decryption is attempted.
 */
export type CryptoErrorCode = 'auth-failed' | 'malformed' | 'unsupported-version' | 'invalid-recovery-key';

export class CryptoError extends Error {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CryptoError';
    this.code = code;
  }
}
