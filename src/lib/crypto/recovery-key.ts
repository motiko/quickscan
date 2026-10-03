import { CryptoError } from './errors';
import { randomBytes, type Bytes } from './encoding';
import { unwrapVaultKey, wrapVaultKey, type WrappedVaultKey } from './wrap';

/*
 * Recovery key: 128 random bits, shown once, e.g.
 *
 *   K7QF-29MX-0H3D-RW5N-8TBE-4ZCJ-6PAY
 *
 * 28 characters in Crockford base32 (0-9 A-Z without I L O U), grouped by 4:
 *   - characters 1-26: the 16 bytes as a big-endian bit stream, 5 bits per character
 *     (130 bits; the 2 trailing pad bits must be zero);
 *   - characters 27-28: two Reed-Solomon check symbols over GF(32) (polynomial
 *     x^5 + x^2 + 1, roots α and α²). The code has minimum distance 3, so *every* single
 *     wrong character, every swap of two characters and every pair of wrong characters is
 *     detected — before any decryption is attempted. (An error-detecting code, not crypto:
 *     the key's secrecy comes only from the 128 random bits.)
 *
 * Parsing is case-insensitive, ignores dashes and whitespace anywhere, and reads O as 0 and
 * I / L as 1 (the Crockford convention), since people copy from paper.
 *
 * Never log a recovery key or keep it beyond the screen that shows it.
 */

export const RECOVERY_KEY_BYTES = 16;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DATA_SYMBOLS = 26;
const SYMBOLS = DATA_SYMBOLS + 2;
const GROUP = 4;

// GF(32) log / antilog tables, α = 2, primitive polynomial x^5 + x^2 + 1
const EXP = new Uint8Array(62);
const LOG = new Uint8Array(32);
for (let i = 0, x = 1; i < 31; i++) {
  EXP[i] = EXP[i + 31] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x20) x ^= 0x25;
}
const mul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
const div = (a: number, b: number) => (a ? EXP[(LOG[a] + 31 - LOG[b]) % 31] : 0);
const pow = (e: number) => EXP[e % 31];

/** Σ c_i · α^(j·i) over the given symbols. */
function syndrome(symbols: readonly number[], j: number): number {
  let s = 0;
  symbols.forEach((c, i) => (s ^= mul(c, pow(j * i))));
  return s;
}

/** The two check symbols that make the syndromes for α and α² vanish. */
function checkSymbols(data: readonly number[]): [number, number] {
  const A = syndrome(data, 1);
  const B = syndrome(data, 2);
  const a = pow(DATA_SYMBOLS), b = pow(DATA_SYMBOLS + 1);
  const c = pow(2 * DATA_SYMBOLS), d = pow(2 * DATA_SYMBOLS + 2);
  const det = mul(a, d) ^ mul(b, c);
  return [div(mul(A, d) ^ mul(b, B), det), div(mul(a, B) ^ mul(c, A), det)];
}

export function formatRecoveryKey(bytes: Uint8Array): string {
  if (bytes.length !== RECOVERY_KEY_BYTES) throw new RangeError(`Recovery key must be ${RECOVERY_KEY_BYTES} bytes`);
  const data: number[] = [];
  let acc = 0, bits = 0;
  for (const byte of bytes) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >> bits) & 31);
    }
    acc &= (1 << bits) - 1;
  }
  data.push((acc << (5 - bits)) & 31); // 3 remaining bits + 2 zero pad bits
  const chars = [...data, ...checkSymbols(data)].map((s) => ALPHABET[s]).join('');
  return chars.match(new RegExp(`.{1,${GROUP}}`, 'g'))!.join('-');
}

export function generateRecoveryKey(): string {
  return formatRecoveryKey(randomBytes(RECOVERY_KEY_BYTES));
}

function invalid(reason: string): CryptoError {
  return new CryptoError('invalid-recovery-key', `Invalid recovery key: ${reason}`);
}

/** Parse user input back into the 16 key bytes. Throws `CryptoError('invalid-recovery-key')`. */
export function parseRecoveryKey(input: string): Bytes {
  const normalized = input.toUpperCase().replace(/[\s\-‐-―]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (normalized.length !== SYMBOLS) throw invalid(`expected ${SYMBOLS} characters, got ${normalized.length}`);
  const symbols: number[] = [];
  for (const ch of normalized) {
    const s = ALPHABET.indexOf(ch);
    if (s < 0) throw invalid('unexpected character');
    symbols.push(s);
  }
  if (syndrome(symbols, 1) !== 0 || syndrome(symbols, 2) !== 0 || (symbols[DATA_SYMBOLS - 1] & 0b11) !== 0) {
    throw invalid('checksum mismatch (typo?)');
  }
  const out = new Uint8Array(RECOVERY_KEY_BYTES);
  let acc = 0, bits = 0, n = 0;
  for (const s of symbols.slice(0, DATA_SYMBOLS)) {
    acc = (acc << 5) | s;
    bits += 5;
    if (bits >= 8 && n < RECOVERY_KEY_BYTES) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  return out;
}

export function isValidRecoveryKey(input: string): boolean {
  try {
    parseRecoveryKey(input);
    return true;
  } catch {
    return false;
  }
}

/** Wrap the (extractable, transient) vault key with a recovery key, for a `vault_keys` row. */
export async function wrapVaultKeyWithRecoveryKey(
  vaultKey: CryptoKey,
  recoveryKey: string,
  opts: { userId: string }
): Promise<WrappedVaultKey> {
  return wrapVaultKey(vaultKey, parseRecoveryKey(recoveryKey), { userId: opts.userId, method: 'recovery' });
}

/**
 * Unwrap a `vault_keys` row with a recovery key typed by the user. A typo throws
 * `invalid-recovery-key` without touching the row; a valid but wrong key throws `auth-failed`.
 */
export async function unwrapVaultKeyWithRecoveryKey(
  row: { wrappedKey: Uint8Array; params: unknown },
  recoveryKey: string,
  opts: { userId: string }
): Promise<CryptoKey> {
  const secret = parseRecoveryKey(recoveryKey);
  return unwrapVaultKey(row, secret, opts);
}
