import {
  CryptoError,
  createPairingKeyPair,
  loadTransferableVaultKey,
  openPairedVaultKey,
  sealVaultKeyForPairing,
  type PairingKeyPair,
} from '@/lib/crypto';
import { getAuthState } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { fromBytea, toBytea } from '@/lib/bytea';
import {
  PAIRING_CODE_MESSAGES,
  PairingCodeError,
  createPairingRequestId,
  formatPairingCode,
  pairingFingerprint,
  parsePairingCode,
} from '@/lib/pairing-code';
import { VaultError, unlockWithPairedKey } from '@/lib/vault-session';

/*
 * QR pairing: an unlocked device hands the vault key to a new device of the same account.
 *
 * New device (locked)                         Unlocked device
 * ---------------------------------------     ------------------------------------------
 * PairingRequest.create():
 *   one-time key pair + random request id
 *   insert pairing_requests { id }
 *   show QR  qs1:<id>:<public key>      --->  sendVaultKeyToDevice(scanned text):
 *                                               parse strictly (lib/pairing-code.ts)
 *                                               the row must exist in *this* account
 *                                               seal the vault key to the QR's public key
 *                                               update … set sealed_key where id = … and
 *                                                 sealed_key is null — exactly one row
 * poll() every 2 s: sealed_key arrives  <---
 *   open it, keep the vault key, delete the row, unlock
 *
 * The public key travels only in the QR code, never via the server (ECIES doesn't
 * authenticate the sender; see lib/crypto/pairing.ts). The server sees the request id and
 * the sealed key, which only the new device's private key opens.
 *
 * The exactly-one-row update is what stops someone from showing you *their* QR code: their
 * request lives in their account, which row-level security hides from yours, so the update
 * matches nothing and nothing is sent. Expired requests are hidden the same way.
 */

export const PAIRING_TTL_MS = 5 * 60_000;
export const PAIRING_POLL_MS = 2_000;
/** Stop polling a little before the server's expiry, which started slightly earlier. */
const EXPIRY_MARGIN_MS = 2_000;

const TABLE = 'pairing_requests';

export type PairingErrorCode =
  'invalid-code' | 'unsupported-version' | 'not-found' | 'bad-key' | 'signed-out' | 'locked' | 'network';

const MESSAGES: Record<PairingErrorCode, string> = {
  ...PAIRING_CODE_MESSAGES,
  'not-found':
    "This code isn't valid for your account or has expired. Check that both devices are signed in to the same account, then show a new code.",
  'bad-key': "The key from your other device couldn't be opened here. Show a new code and scan it again.",
  'signed-out': 'Sign in first.',
  locked: 'Unlock sync on this device first.',
  network: "Couldn't reach the server. Check your connection and try again.",
};

export class PairingError extends Error {
  readonly code: PairingErrorCode;

  constructor(code: PairingErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'PairingError';
    this.code = code;
  }
}

function requireUserId(): string {
  const auth = getAuthState();
  if (auth.status !== 'signed-in') throw new PairingError('signed-out');
  return auth.user.id;
}

async function supabaseOrThrow() {
  try {
    return await getSupabase();
  } catch (cause) {
    throw new PairingError('network', { cause });
  }
}

// ---------------------------------------------------------------------------
// New device
// ---------------------------------------------------------------------------

export type PairingStatus = 'waiting' | 'paired' | 'expired' | 'cancelled';

export interface PairingRequestOptions {
  /** Clock for tests. */
  now?: () => number;
}

/**
 * One pairing attempt on the new device: owns the one-time private key (memory only) and the
 * `pairing_requests` row. Drive it with `poll()` every `PAIRING_POLL_MS` until it isn't
 * 'waiting'; `cancel()` when the person leaves. After any outcome the private key is dropped.
 */
export class PairingRequest {
  readonly requestId: string;
  /** The QR code text. */
  readonly code: string;
  /** Short code shown under the QR; the scanning device shows the same. */
  readonly fingerprint: string;
  /** Local epoch ms after which the request no longer counts (the countdown's end). */
  readonly expiresAt: number;

  private keyPair: PairingKeyPair | null;
  private readonly userId: string;
  private readonly now: () => number;
  private status: PairingStatus = 'waiting';
  private inFlight: Promise<PairingStatus> | null = null;

  private constructor(init: {
    requestId: string;
    code: string;
    fingerprint: string;
    expiresAt: number;
    keyPair: PairingKeyPair;
    userId: string;
    now: () => number;
  }) {
    this.requestId = init.requestId;
    this.code = init.code;
    this.fingerprint = init.fingerprint;
    this.expiresAt = init.expiresAt;
    this.keyPair = init.keyPair;
    this.userId = init.userId;
    this.now = init.now;
  }

  /** Create the key pair and the server row. Throws `PairingError` ('signed-out', 'network'). */
  static async create(options: PairingRequestOptions = {}): Promise<PairingRequest> {
    const now = options.now ?? Date.now;
    const userId = requireUserId();
    const keyPair = await createPairingKeyPair();
    const requestId = createPairingRequestId();
    const code = formatPairingCode({ requestId, publicKey: keyPair.publicKey });
    const fingerprint = await pairingFingerprint({ requestId, publicKey: keyPair.publicKey });
    const supabase = await supabaseOrThrow();
    // Taken before the insert: the server's now() + 5 min is at or after this deadline.
    const started = now();
    // user_id and expires_at come from the column defaults (auth.uid(), now() + 5 min).
    const { error } = await supabase.from(TABLE).insert({ id: requestId });
    if (error) throw new PairingError('network', { cause: error });
    return new PairingRequest({
      requestId,
      code,
      fingerprint,
      expiresAt: started + PAIRING_TTL_MS - EXPIRY_MARGIN_MS,
      keyPair,
      userId,
      now,
    });
  }

  getStatus(): PairingStatus {
    return this.status;
  }

  /**
   * Check once whether the unlocked device has answered. Resolves 'paired' after unlocking
   * this device. Throws `PairingError` 'network' for a failed check (keep polling) and
   * 'bad-key' when the answer can't be opened (the attempt is over; show a new code).
   */
  poll(): Promise<PairingStatus> {
    if (this.status !== 'waiting') return Promise.resolve(this.status);
    this.inFlight ??= this.check().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async check(): Promise<PairingStatus> {
    if (this.now() >= this.expiresAt) return this.finish('expired');
    const supabase = await supabaseOrThrow();
    const { data, error } = await supabase.from(TABLE).select('sealed_key').eq('id', this.requestId).maybeSingle();
    if (this.status !== 'waiting') return this.status; // cancelled meanwhile
    if (error) throw new PairingError('network', { cause: error });
    // Hidden by RLS once expired (or deleted elsewhere): this request is over.
    if (!data) return this.finish('expired');
    if (data.sealed_key == null) return 'waiting';

    const keyPair = this.keyPair!;
    let vaultKey: CryptoKey;
    try {
      vaultKey = await openPairedVaultKey(keyPair, fromBytea(data.sealed_key), this.requestId);
    } catch (cause) {
      this.finish('cancelled');
      await this.deleteRow();
      throw new PairingError('bad-key', { cause });
    }
    if (this.status !== 'waiting') return this.status; // cancelled while opening: drop the key
    this.finish('paired');
    await this.deleteRow();
    try {
      await unlockWithPairedKey(vaultKey, this.userId);
    } catch (cause) {
      this.status = 'cancelled';
      throw cause instanceof VaultError ? new PairingError('signed-out', { cause }) : cause;
    }
    return 'paired';
  }

  /** Stop waiting and delete the row (best effort; it expires anyway). */
  async cancel(): Promise<void> {
    if (this.status !== 'waiting') return;
    this.finish('cancelled');
    await this.deleteRow();
  }

  private finish(status: PairingStatus): PairingStatus {
    this.status = status;
    this.keyPair = null; // the private key is single-use; let it be collected
    return status;
  }

  private async deleteRow(): Promise<void> {
    try {
      const supabase = await getSupabase();
      await supabase.from(TABLE).delete().eq('id', this.requestId);
    } catch {
      // Offline: the row expires within 5 minutes and RLS hides it from then on.
    }
  }
}

// ---------------------------------------------------------------------------
// Unlocked device
// ---------------------------------------------------------------------------

/**
 * Send this device's vault key to the device that shows `scannedText` as a QR code. Resolves
 * with the fingerprint to show. Throws `PairingError`: 'invalid-code' / 'unsupported-version'
 * for text that isn't a valid code, 'not-found' when the request isn't one of this account's
 * live requests (nothing is sealed or sent then), 'locked', 'signed-out', 'network'.
 */
export async function sendVaultKeyToDevice(scannedText: string): Promise<{ fingerprint: string }> {
  requireUserId();
  let parsed;
  try {
    parsed = parsePairingCode(scannedText);
  } catch (cause) {
    throw new PairingError(cause instanceof PairingCodeError ? cause.code : 'invalid-code', { cause });
  }
  const { requestId, publicKey } = parsed;
  const supabase = await supabaseOrThrow();

  // Only seal for a request this account made and nobody has answered yet.
  const { data: existing, error: lookupError } = await supabase
    .from(TABLE)
    .select('id')
    .eq('id', requestId)
    .is('sealed_key', null)
    .maybeSingle();
  if (lookupError) throw new PairingError('network', { cause: lookupError });
  if (!existing) throw new PairingError('not-found');

  const vaultKey = await loadTransferableVaultKey();
  if (!vaultKey) throw new PairingError('locked');
  let sealed: Uint8Array;
  try {
    sealed = await sealVaultKeyForPairing(vaultKey, publicKey, requestId);
  } catch (cause) {
    // Not a point on P-256.
    if (cause instanceof CryptoError) throw new PairingError('invalid-code', { cause });
    throw cause;
  }

  // The update decides: exactly one row of this account, still unanswered and not expired.
  const { data: updated, error } = await supabase
    .from(TABLE)
    .update({ sealed_key: toBytea(sealed) })
    .eq('id', requestId)
    .is('sealed_key', null)
    .select('id');
  if (error) throw new PairingError('network', { cause: error });
  if (!updated || updated.length !== 1) throw new PairingError('not-found');
  return { fingerprint: await pairingFingerprint(parsed) };
}
