import { CryptoError, loadTransferableVaultKey, unwrapVaultKey, wrapVaultKey, type WrapParams } from '@/lib/crypto';
import { fromBase64, randomBytes, toBase64 } from '@/lib/crypto/encoding';
import { getAuthState, type AuthUser } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { fromBytea, toBytea } from '@/lib/bytea';
import { getVaultStatus, unlockWithPairedKey } from '@/lib/vault-session';

/*
 * Passkeys as an extra way to unlock sync, through the WebAuthn PRF extension. The recovery
 * key always stays; a passkey is one more `vault_keys` row (method 'passkey', id = the
 * credential id) holding the vault key wrapped by the passkey's PRF output.
 *
 *   add (unlocked device)                       unlock (locked device)
 *   -------------------------------------       ---------------------------------------------
 *   salt = 32 random bytes (not secret)         rows = this account's passkey rows for rpId
 *   credentials.create(prf: eval {first: salt}) credentials.get(allowCredentials = rows,
 *   no PRF results at create (iOS/Safari)?        prf: evalByCredential {id → its salt})
 *     → credentials.get(that credential, salt)  row = rows[returned credential id]
 *   prf = 32-byte output (secret, transient)    vault key = unwrapVaultKey(row, prf)
 *   insert { wrapped_key: wrapVaultKey(prf),    keep it, unlock
 *            params: {…wrap params, prfSalt,
 *                     credentialId, rpId} }
 *
 * The PRF output is the only secret here. It exists as transient bytes inside one call,
 * is never logged or stored, and is zeroed after use. The challenge is random and never
 * verified: nothing is authenticated by the assertion signature, only by whether the PRF
 * output opens the wrapped key.
 *
 * rpId is the page's hostname, so passkeys made on production don't work on preview
 * deployments (other hostnames), and vice versa.
 *
 * WebAuthn calls need a recent user gesture (Safari is strict), so everything that needs
 * the network (the list of passkey rows) is fetched before the button is pressed and passed
 * in, and `create`/`get` are the first awaited calls of each flow.
 */

export const PASSKEYS_CHANGED_EVENT = 'quickscan:passkeys-changed';

const PRF_SALT_BYTES = 32;
const CHALLENGE_BYTES = 32;
const TIMEOUT_MS = 120_000;
const LABEL_MAX = 200;
/** Postgres unique_violation. */
const UNIQUE_VIOLATION = '23505';

export interface PasskeyParams extends WrapParams {
  method: 'passkey';
  /** Base64 PRF salt (32 bytes), evaluated as `prf.eval.first`. Not secret. */
  prfSalt: string;
  /** Base64url credential id (same as the row id). */
  credentialId: string;
  /** Hostname the passkey is bound to. */
  rpId: string;
}

export interface PasskeyInfo {
  /** Base64url credential id, also the `vault_keys.id`. */
  id: string;
  label: string;
  createdAt: string;
  rpId: string;
  prfSalt: string;
}

export type PasskeyErrorCode =
  | 'unsupported'
  | 'cancelled'
  | 'already-added'
  | 'no-passkeys'
  | 'unknown-passkey'
  | 'wrong-passkey'
  | 'needs-confirmation'
  | 'site'
  | 'signed-out'
  | 'locked'
  | 'network'
  | 'failed';

const MESSAGES: Record<PasskeyErrorCode, string> = {
  unsupported:
    "This browser or password manager can't unlock sync with a passkey. Use your recovery key, or scan a QR code from another device, instead. Nothing was saved.",
  cancelled: 'The passkey request was cancelled or timed out. Try again when you’re ready.',
  'already-added': 'This password manager already has a QuickScan passkey for your account.',
  'no-passkeys': 'No passkey is set up to unlock sync on this site. Use your recovery key.',
  'unknown-passkey':
    "That passkey isn't set up to unlock sync for this account (it may have been removed). Try another passkey or use your recovery key.",
  'wrong-passkey': "That passkey couldn't unlock sync. Use your recovery key, then add the passkey again.",
  'needs-confirmation': 'Confirm your new passkey once more so it can unlock sync.',
  site: "Passkeys don't work on this address. Use your recovery key.",
  'signed-out': 'Sign in first.',
  locked: 'Unlock sync on this device first.',
  network: "Couldn't reach the server. Check your connection and try again.",
  failed: 'The passkey request failed. Try again, or use your recovery key.',
};

/** A passkey that was created but whose PRF output still needs a second prompt. */
export interface PendingPasskey {
  userId: string;
  credentialId: string;
  rpId: string;
  prfSalt: string;
  label: string;
}

export class PasskeyError extends Error {
  readonly code: PasskeyErrorCode;
  /** For 'needs-confirmation': pass to `finishPasskey` from a fresh button press. */
  readonly pending?: PendingPasskey;

  constructor(code: PasskeyErrorCode, options?: { cause?: unknown; pending?: PendingPasskey }) {
    super(MESSAGES[code], options);
    this.name = 'PasskeyError';
    this.code = code;
    this.pending = options?.pending;
  }
}

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

export type PasskeySupport = 'supported' | 'unsupported' | 'unknown';

/**
 * 'unsupported' when WebAuthn is missing or the browser says it lacks PRF; 'supported' when
 * it says it has PRF; 'unknown' otherwise (most browsers before getClientCapabilities) —
 * then the only way to know is to try, and the add flow saves nothing if PRF is missing.
 */
export async function getPasskeySupport(): Promise<PasskeySupport> {
  if (typeof window === 'undefined' || !globalThis.isSecureContext) return 'unsupported';
  const PKC = globalThis.PublicKeyCredential as
    | (typeof PublicKeyCredential & { getClientCapabilities?: () => Promise<Record<string, boolean | undefined>> })
    | undefined;
  if (!PKC || !globalThis.navigator?.credentials) return 'unsupported';
  if (typeof PKC.getClientCapabilities !== 'function') return 'unknown';
  try {
    const caps = await PKC.getClientCapabilities();
    if (caps['extension:prf'] === true) return 'supported';
    if (caps['extension:prf'] === false) return 'unsupported';
  } catch {
    // fall through
  }
  return 'unknown';
}

/** "iPhone passkey", "Mac passkey", … from the user agent; the user can rename it later. */
export function defaultPasskeyLabel(userAgent: string, maxTouchPoints = 0): string {
  const device = /iPhone/.test(userAgent)
    ? 'iPhone'
    : /iPad/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
      ? 'iPad'
      : /Android/.test(userAgent)
        ? 'Android'
        : /Macintosh|Mac OS X/.test(userAgent)
          ? 'Mac'
          : /CrOS/.test(userAgent)
            ? 'Chromebook'
            : /Windows/.test(userAgent)
              ? 'Windows'
              : /Linux/.test(userAgent)
                ? 'Linux'
                : null;
  return device ? `${device} passkey` : 'Passkey';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireUser(): AuthUser {
  const auth = getAuthState();
  if (auth.status !== 'signed-in') throw new PasskeyError('signed-out');
  return auth.user;
}

function currentRpId(): string {
  return globalThis.location.hostname;
}

async function supabase() {
  return getSupabase().catch((cause) => {
    throw new PasskeyError('network', { cause });
  });
}

function announce() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PASSKEYS_CHANGED_EVENT));
}

/** WebAuthn DOMExceptions → friendly codes. */
function webauthnError(cause: unknown, inCreate = false): PasskeyError {
  if (cause instanceof PasskeyError) return cause;
  const name = (cause as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return new PasskeyError('cancelled', { cause });
  if (name === 'InvalidStateError' && inCreate) return new PasskeyError('already-added', { cause });
  if (name === 'SecurityError') return new PasskeyError('site', { cause });
  if (name === 'NotSupportedError') return new PasskeyError('unsupported', { cause });
  return new PasskeyError('failed', { cause });
}

function prfFirst(credential: PublicKeyCredential): Uint8Array<ArrayBuffer> | null {
  const first = credential.getClientExtensionResults().prf?.results?.first;
  if (!first) return null;
  const bytes = ArrayBuffer.isView(first)
    ? new Uint8Array(first.buffer, first.byteOffset, first.byteLength)
    : new Uint8Array(first);
  return bytes as Uint8Array<ArrayBuffer>;
}

/** Ask the password manager to forget a passkey we won't use (best effort, newer browsers). */
function forgetCredential(rpId: string, credentialId: string) {
  const PKC = globalThis.PublicKeyCredential as
    | { signalUnknownCredential?: (o: { rpId: string; credentialId: string }) => Promise<void> }
    | undefined;
  if (rpId !== currentRpId() || typeof PKC?.signalUnknownCredential !== 'function') return;
  PKC.signalUnknownCredential({ rpId, credentialId }).catch(() => {});
}

function credentialIdOf(credential: PublicKeyCredential): string {
  return toBase64(new Uint8Array(credential.rawId), true);
}

// ---------------------------------------------------------------------------
// Listing, renaming, removing
// ---------------------------------------------------------------------------

/** All passkey rows of the signed-in account, oldest first (any rpId). */
export async function listPasskeys(): Promise<PasskeyInfo[]> {
  requireUser();
  const client = await supabase();
  const { data, error } = await client.from('vault_keys').select('id, label, created_at, params').eq('method', 'passkey');
  if (error) throw new PasskeyError('network', { cause: error });
  return (data as { id: string; label: string | null; created_at: string; params: Partial<PasskeyParams> }[])
    .filter((r) => typeof r.params?.prfSalt === 'string' && typeof r.params?.rpId === 'string')
    .map((r) => ({
      id: r.id,
      label: r.label || 'Passkey',
      createdAt: r.created_at,
      rpId: r.params.rpId!,
      prfSalt: r.params.prfSalt!,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** The passkeys usable on this hostname. */
export function passkeysForThisSite(passkeys: PasskeyInfo[]): PasskeyInfo[] {
  const rpId = currentRpId();
  return passkeys.filter((p) => p.rpId === rpId);
}

export async function renamePasskey(id: string, label: string): Promise<void> {
  requireUser();
  const client = await supabase();
  const { error } = await client
    .from('vault_keys')
    .update({ label: label.trim().slice(0, LABEL_MAX) || 'Passkey' })
    .eq('id', id)
    .eq('method', 'passkey');
  if (error) throw new PasskeyError('network', { cause: error });
  announce();
}

/**
 * Delete a passkey row: it can no longer unlock new devices. Devices that are already
 * unlocked keep the vault key, and a copy of the old wrapped key still opens with the
 * passkey — real revocation needs a vault-key rotation (see SECURITY.md).
 */
export async function removePasskey(passkey: Pick<PasskeyInfo, 'id' | 'rpId'>): Promise<void> {
  requireUser();
  const client = await supabase();
  const { error } = await client.from('vault_keys').delete().eq('id', passkey.id).eq('method', 'passkey');
  if (error) throw new PasskeyError('network', { cause: error });
  forgetCredential(passkey.rpId, passkey.id);
  announce();
}

// ---------------------------------------------------------------------------
// Adding
// ---------------------------------------------------------------------------

/**
 * Create a passkey with PRF and store the vault key wrapped by its output. Call it straight
 * from a button press; `excludeIds` are the account's existing passkey ids (so the same
 * password manager isn't registered twice).
 *
 * Throws `PasskeyError`: 'unsupported' (no PRF: nothing saved), 'cancelled',
 * 'already-added', or 'needs-confirmation' with `pending` when the platform returned no PRF
 * output at create and the follow-up prompt couldn't run (e.g. Safari wanting a fresh tap):
 * call `finishPasskey(err.pending)` from another button press.
 */
export async function addPasskey(opts: { excludeIds?: string[]; label?: string } = {}): Promise<PasskeyInfo> {
  const user = requireUser();
  if (getVaultStatus().status !== 'unlocked') throw new PasskeyError('locked');
  const rpId = currentRpId();
  const salt = randomBytes(PRF_SALT_BYTES);

  let credential: PublicKeyCredential;
  try {
    const created = await navigator.credentials.create({
      publicKey: {
        rp: { id: rpId, name: 'QuickScan' },
        // The account id, so a password manager keeps one QuickScan passkey per account.
        user: { id: new TextEncoder().encode(user.id), name: user.email, displayName: user.email },
        challenge: randomBytes(CHALLENGE_BYTES),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: (opts.excludeIds ?? []).map((id) => ({ type: 'public-key' as const, id: fromBase64(id) })),
        attestation: 'none',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    if (!created) throw new PasskeyError('failed');
    credential = created as PublicKeyCredential;
  } catch (cause) {
    throw webauthnError(cause, true);
  }

  const credentialId = credentialIdOf(credential);
  const pending: PendingPasskey = {
    userId: user.id,
    credentialId,
    rpId,
    prfSalt: toBase64(salt),
    label: (opts.label?.trim() || defaultPasskeyLabel(navigator.userAgent, navigator.maxTouchPoints)).slice(0, LABEL_MAX),
  };

  const prf = credential.getClientExtensionResults().prf;
  if (prf?.enabled !== true) {
    forgetCredential(rpId, credentialId);
    throw new PasskeyError('unsupported');
  }
  const output = prfFirst(credential);
  // Platforms such as iOS/Safari enable PRF at create but only evaluate it on get.
  if (!output) return finishPasskey(pending, { fromCreate: true });
  return savePasskey(pending, output);
}

/**
 * Second half of `addPasskey` for platforms that only evaluate PRF on `get`: one assertion
 * with the new credential and the same salt.
 */
export async function finishPasskey(pending: PendingPasskey, opts: { fromCreate?: boolean } = {}): Promise<PasskeyInfo> {
  let credential: PublicKeyCredential;
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        rpId: pending.rpId,
        allowCredentials: [{ type: 'public-key', id: fromBase64(pending.credentialId) }],
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: { prf: { eval: { first: fromBase64(pending.prfSalt) } } },
      },
    });
    if (!got) throw new PasskeyError('failed');
    credential = got as PublicKeyCredential;
  } catch (cause) {
    const err = webauthnError(cause);
    // Right after create, Safari may refuse a second prompt without a new tap.
    if (opts.fromCreate && err.code === 'cancelled') throw new PasskeyError('needs-confirmation', { cause, pending });
    throw err;
  }
  const output = prfFirst(credential);
  if (!output || credentialIdOf(credential) !== pending.credentialId) {
    if (output) output.fill(0);
    forgetCredential(pending.rpId, pending.credentialId);
    throw new PasskeyError('unsupported');
  }
  return savePasskey(pending, output);
}

/** Wrap the vault key with the PRF output (zeroed afterwards) and insert the row. */
async function savePasskey(pending: PendingPasskey, output: Uint8Array): Promise<PasskeyInfo> {
  let wrapped;
  try {
    const user = requireUser();
    if (user.id !== pending.userId) throw new PasskeyError('signed-out');
    const vaultKey = await loadTransferableVaultKey();
    if (!vaultKey) throw new PasskeyError('locked');
    wrapped = await wrapVaultKey(vaultKey, output, { userId: user.id, method: 'passkey' });
  } finally {
    output.fill(0);
  }
  const params: PasskeyParams = {
    ...wrapped.params,
    method: 'passkey',
    prfSalt: pending.prfSalt,
    credentialId: pending.credentialId,
    rpId: pending.rpId,
  };
  const client = await supabase();
  const { error } = await client.from('vault_keys').insert({
    id: pending.credentialId,
    method: 'passkey',
    wrapped_key: toBytea(wrapped.wrappedKey),
    params,
    label: pending.label,
  });
  if (error?.code === UNIQUE_VIOLATION) throw new PasskeyError('already-added', { cause: error });
  if (error) throw new PasskeyError('network', { cause: error });
  announce();
  return {
    id: pending.credentialId,
    label: pending.label,
    createdAt: new Date().toISOString(),
    rpId: pending.rpId,
    prfSalt: pending.prfSalt,
  };
}

// ---------------------------------------------------------------------------
// Unlocking
// ---------------------------------------------------------------------------

/**
 * Unlock this device with one of the account's passkeys for this hostname. `passkeys` is the
 * list fetched before the button press (`listPasskeys()`); without it, it's fetched first.
 */
export async function unlockWithPasskey(passkeys?: PasskeyInfo[]): Promise<void> {
  const user = requireUser();
  const candidates = passkeysForThisSite(passkeys ?? (await listPasskeys()));
  if (candidates.length === 0) throw new PasskeyError('no-passkeys');

  let credential: PublicKeyCredential;
  try {
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: randomBytes(CHALLENGE_BYTES),
        rpId: currentRpId(),
        allowCredentials: candidates.map((p) => ({ type: 'public-key' as const, id: fromBase64(p.id) })),
        userVerification: 'required',
        timeout: TIMEOUT_MS,
        extensions: {
          prf: { evalByCredential: Object.fromEntries(candidates.map((p) => [p.id, { first: fromBase64(p.prfSalt) }])) },
        },
      },
    });
    if (!got) throw new PasskeyError('failed');
    credential = got as PublicKeyCredential;
  } catch (cause) {
    throw webauthnError(cause);
  }

  const output = prfFirst(credential);
  try {
    const credentialId = credentialIdOf(credential);
    if (!candidates.some((p) => p.id === credentialId)) throw new PasskeyError('unknown-passkey');
    if (!output) throw new PasskeyError('unsupported');

    // Fetched after the prompt (a removed row must not unlock), never cached.
    const client = await supabase();
    const { data, error } = await client
      .from('vault_keys')
      .select('wrapped_key, params')
      .eq('id', credentialId)
      .eq('method', 'passkey')
      .maybeSingle();
    if (error) throw new PasskeyError('network', { cause: error });
    if (!data) throw new PasskeyError('unknown-passkey');

    let vaultKey: CryptoKey;
    try {
      vaultKey = await unwrapVaultKey({ wrappedKey: fromBytea(data.wrapped_key), params: data.params }, output, {
        userId: user.id,
      });
    } catch (cause) {
      if (cause instanceof CryptoError && cause.code === 'auth-failed') throw new PasskeyError('wrong-passkey', { cause });
      throw new PasskeyError('failed', { cause });
    }
    await unlockWithPairedKey(vaultKey, user.id); // VaultError 'signed-out' if the account changed meanwhile
  } finally {
    output?.fill(0);
  }
}
