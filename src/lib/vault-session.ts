import { db } from '@/lib/db';
import {
  CryptoError,
  clearVaultKey,
  generateVaultKey,
  loadTransferableVaultKey,
  loadVaultKey,
  parseRecoveryKey,
  storeVaultKey,
  unwrapVaultKeyWithRecoveryKey,
  wrapVaultKeyWithRecoveryKey,
} from '@/lib/crypto';
import { getAuthState, subscribeAuth, type AuthState, type AuthUser } from '@/lib/auth';
import { getSupabase } from '@/lib/supabase';
import { fromBytea, toBytea } from '@/lib/bytea';
import { withTimeout } from '@/lib/timeout';

/*
 * Whether this device holds the sync vault key, as a small store for useSyncExternalStore
 * (read it with `useVault()`), plus the flows that change it: turning sync on with a new
 * recovery key, unlocking with the recovery key, replacing the recovery key, and forgetting
 * the key on sign-out.
 *
 * The vault key itself never passes through here in a usable form beyond the call that
 * stores it; the sync engine loads it with `loadVaultKey()`. The recovery key is only a
 * function argument: never stored, logged or sent (only the key wrapped by it goes to
 * Supabase).
 *
 * Every unlock, creation or clear dispatches `VAULT_CHANGED_EVENT` on `window`, which the
 * sync engine listens for.
 */

export type VaultStatus = 'disabled' | 'signed-out' | 'checking' | 'no-vault' | 'locked' | 'unlocked' | 'error';

export type VaultState =
  | { status: Exclude<VaultStatus, 'error'> }
  | { status: 'error'; message: string };

export const VAULT_CHANGED_EVENT = 'quickscan:vault-changed';

/** `vault_keys.id` (and `method`) of the recovery-key row; passkey rows use their credential id. */
export const RECOVERY_ROW_ID = 'recovery';

/** `syncMeta` entry naming the account the stored vault key belongs to. */
const VAULT_OWNER_META = 'vaultOwner';
/** Postgres unique_violation: the row exists already. */
const UNIQUE_VIOLATION = '23505';

export type VaultErrorCode =
  | 'signed-out'
  | 'invalid-recovery-key' // doesn't parse: a typo
  | 'wrong-recovery-key' // parses, but isn't the key of this account's vault
  | 'no-vault'
  | 'locked'
  | 'unsupported'
  | 'network'
  | 'storage';

const MESSAGES: Record<VaultErrorCode, string> = {
  'signed-out': 'Sign in first.',
  'invalid-recovery-key': 'That recovery key has a typo. Check each character against your saved copy.',
  'wrong-recovery-key':
    "That's a valid recovery key, but not the one for this account. If you created a new one, use the newest.",
  'no-vault': "Sync isn't turned on for this account yet.",
  locked: 'Unlock sync on this device first.',
  unsupported: 'Your sync key was saved by a newer version of QuickScan. Update the app and try again.',
  network: "Couldn't reach the server. Check your connection and try again.",
  storage: "Couldn't read this device's storage. Close other QuickScan tabs and try again.",
};

/** The status check never shows "Checking sync…" for longer than these. */
export const LOCAL_CHECK_TIMEOUT_MS = 10_000;
export const SERVER_CHECK_TIMEOUT_MS = 15_000;

/**
 * Set (in memory and in localStorage, which doesn't depend on IndexedDB) the moment the key is
 * to be forgotten, and cleared once it's gone from `syncMeta`. While set, the stored key counts
 * as absent: no sync run may use it, and the next start retries deleting it. That keeps
 * sign-out instant even if IndexedDB doesn't answer.
 */
const FORGET_PENDING_KEY = 'quickscan:forget-vault-key';
let forgetPending = false;

function readForgetMarker(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(FORGET_PENDING_KEY) === '1';
  } catch {
    return false;
  }
}

function setForgetPending(pending: boolean) {
  forgetPending = pending;
  try {
    if (typeof localStorage === 'undefined') return;
    if (pending) localStorage.setItem(FORGET_PENDING_KEY, '1');
    else localStorage.removeItem(FORGET_PENDING_KEY);
  } catch {
    // Storage unavailable (private mode): the in-memory flag still covers this session
  }
}

/** True while a forgotten vault key may still be stored: treat it as gone. */
export function isVaultKeyRevoked(): boolean {
  return forgetPending || readForgetMarker();
}

/** At start: finish deleting a key whose deletion didn't complete (e.g. sign-out while storage hung). */
export async function retryPendingVaultForget(): Promise<void> {
  if (!isVaultKeyRevoked()) return;
  try {
    await withTimeout(forgetLocalKey(), LOCAL_CHECK_TIMEOUT_MS, 'Forgetting the vault key');
  } catch (err) {
    console.warn('Sync: could not remove the forgotten vault key yet', err);
  }
}

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, options?: { cause?: unknown }) {
    super(MESSAGES[code], options);
    this.name = 'VaultError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const initial = getAuthState().status;
let state: VaultState = { status: initial === 'disabled' ? 'disabled' : initial === 'signed-out' ? 'signed-out' : 'checking' };
let started = false;
/** The account the state describes; a change of account re-checks. */
let currentUserId: string | null = null;
/** Bumped by every check and every flow, so a stale async result never overwrites a newer one. */
let generation = 0;
const subscribers = new Set<() => void>();

function setState(next: VaultState) {
  state = next;
  for (const notify of subscribers) notify();
}

function announce() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(VAULT_CHANGED_EVENT));
}

function onAuthChange(auth: AuthState) {
  if (auth.status === 'signed-in') {
    // Token refreshes re-emit the same user: nothing to re-check.
    if (auth.user.id === currentUserId && state.status !== 'error') return;
    currentUserId = auth.user.id;
    void check(auth.user);
    return;
  }
  currentUserId = null;
  generation++;
  setState({ status: auth.status === 'disabled' ? 'disabled' : auth.status === 'loading' ? 'checking' : 'signed-out' });
}

/** Local key first (works offline), then whether the account has a vault on the server. */
async function check(user: AuthUser) {
  const gen = ++generation;
  setState({ status: 'checking' });
  let local: boolean;
  try {
    local = await withTimeout(hasLocalKeyFor(user.id), LOCAL_CHECK_TIMEOUT_MS, 'Reading the vault key');
  } catch (err) {
    console.warn('Sync: checking the local vault key failed', err);
    if (gen === generation) setState({ status: 'error', message: MESSAGES.storage });
    return;
  }
  if (local) {
    if (gen === generation) setState({ status: 'unlocked' });
    return;
  }
  try {
    const { data, error } = await withTimeout(
      getSupabase().then((supabase) => supabase.from('vault_keys').select('id').limit(1)),
      SERVER_CHECK_TIMEOUT_MS,
      'Checking the vault on the server'
    );
    if (error) throw error;
    if (gen === generation) setState({ status: data.length > 0 ? 'locked' : 'no-vault' });
  } catch {
    if (gen === generation) setState({ status: 'error', message: MESSAGES.network });
  }
}

/** A key stored for another account (a sign-out that never ran) is dropped, never used. */
async function hasLocalKeyFor(userId: string): Promise<boolean> {
  if (isVaultKeyRevoked()) {
    await forgetLocalKey();
    return false;
  }
  const stored = await loadVaultKey();
  if (!stored) return false;
  const owner = (await db.syncMeta.get(VAULT_OWNER_META))?.value;
  if (owner === userId) return true;
  await forgetLocalKey();
  return false;
}

async function forgetLocalKey() {
  await clearVaultKey();
  await db.syncMeta.delete(VAULT_OWNER_META);
  setForgetPending(false);
}

/** Keep the (transient, extractable) vault key on this device as the given account's. */
async function keepLocally(transientKey: CryptoKey, userId: string) {
  await db.syncMeta.put({ key: VAULT_OWNER_META, value: userId });
  await storeVaultKey(transientKey);
  // The new key replaced any forgotten one
  setForgetPending(false);
}

/** For useSyncExternalStore; the first subscriber starts following the auth state. */
export function subscribeVault(listener: () => void): () => void {
  subscribers.add(listener);
  if (!started) {
    started = true;
    if (isVaultKeyRevoked()) forgetPending = true;
    subscribeAuth(() => onAuthChange(getAuthState()));
    onAuthChange(getAuthState());
  }
  return () => subscribers.delete(listener);
}

export function getVaultStatus(): VaultState {
  return state;
}

/** Check again, e.g. after an error. */
export async function refreshVault(): Promise<void> {
  const auth = getAuthState();
  if (auth.status !== 'signed-in') return onAuthChange(auth);
  currentUserId = auth.user.id;
  await check(auth.user);
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

function requireUser(): AuthUser {
  const auth = getAuthState();
  if (auth.status !== 'signed-in') throw new VaultError('signed-out');
  return auth.user;
}

function settle(next: VaultState) {
  generation++;
  setState(next);
}

/**
 * Turn sync on: a new vault key, wrapped with `recoveryKey` (which the user has saved by
 * now), stored on the server and kept on this device. Resolves to 'exists' — without
 * overwriting anything — when another device created the vault meanwhile; this device is
 * then locked and needs that device's recovery key.
 */
export async function createVault(recoveryKey: string): Promise<'created' | 'exists'> {
  const user = requireUser();
  const vaultKey = await generateVaultKey();
  const { wrappedKey, params } = await wrapVaultKeyWithRecoveryKey(vaultKey, recoveryKey, { userId: user.id });
  const supabase = await getSupabase().catch((cause) => {
    throw new VaultError('network', { cause });
  });
  const { error } = await supabase.from('vault_keys').insert({
    id: RECOVERY_ROW_ID,
    method: 'recovery',
    wrapped_key: toBytea(wrappedKey),
    params,
  });
  if (error?.code === UNIQUE_VIOLATION) {
    settle({ status: 'locked' });
    return 'exists';
  }
  if (error) throw new VaultError('network', { cause: error });
  await keepLocally(vaultKey, user.id);
  settle({ status: 'unlocked' });
  announce();
  return 'created';
}

/**
 * Unlock this device with the recovery key. Throws `VaultError` 'invalid-recovery-key' for a
 * typo (caught by the checksum before anything is fetched) and 'wrong-recovery-key' for a
 * valid key that doesn't open this account's vault.
 */
export async function unlockVault(recoveryKey: string): Promise<void> {
  const user = requireUser();
  try {
    parseRecoveryKey(recoveryKey);
  } catch (cause) {
    throw new VaultError('invalid-recovery-key', { cause });
  }
  const supabase = await getSupabase().catch((cause) => {
    throw new VaultError('network', { cause });
  });
  const { data, error } = await supabase
    .from('vault_keys')
    .select('wrapped_key, params')
    .eq('id', RECOVERY_ROW_ID)
    .maybeSingle();
  if (error) throw new VaultError('network', { cause: error });
  if (!data) {
    settle({ status: 'no-vault' });
    throw new VaultError('no-vault');
  }

  let vaultKey: CryptoKey;
  try {
    vaultKey = await unwrapVaultKeyWithRecoveryKey(
      { wrappedKey: fromBytea(data.wrapped_key), params: data.params },
      recoveryKey,
      { userId: user.id }
    );
  } catch (cause) {
    if (cause instanceof CryptoError && cause.code === 'auth-failed') throw new VaultError('wrong-recovery-key', { cause });
    if (cause instanceof CryptoError && cause.code === 'invalid-recovery-key') {
      throw new VaultError('invalid-recovery-key', { cause });
    }
    throw new VaultError('unsupported', { cause });
  }
  await keepLocally(vaultKey, user.id);
  settle({ status: 'unlocked' });
  announce();
}

/**
 * Keep a vault key received from another device by QR pairing (lib/pairing-session.ts), or
 * unwrapped with a passkey (lib/passkeys.ts), and unlock. `transientKey` is the extractable
 * key from `openPairedVaultKey`/`unwrapVaultKey`; `userId` is the account the flow started
 * for, so a sign-in switch meanwhile can't attach the key to another account.
 */
export async function unlockWithPairedKey(transientKey: CryptoKey, userId: string): Promise<void> {
  const user = requireUser();
  if (user.id !== userId) throw new VaultError('signed-out');
  await keepLocally(transientKey, user.id);
  settle({ status: 'unlocked' });
  announce();
}

/**
 * Re-wrap this device's vault key under a new recovery key and replace the server row. The
 * old recovery key stops working; devices that are already unlocked are unaffected.
 */
export async function replaceRecoveryKey(recoveryKey: string): Promise<void> {
  const user = requireUser();
  const vaultKey = await loadTransferableVaultKey();
  if (!vaultKey) throw new VaultError('locked');
  const { wrappedKey, params } = await wrapVaultKeyWithRecoveryKey(vaultKey, recoveryKey, { userId: user.id });
  const supabase = await getSupabase().catch((cause) => {
    throw new VaultError('network', { cause });
  });
  const { error } = await supabase.from('vault_keys').upsert(
    {
      id: RECOVERY_ROW_ID,
      method: 'recovery',
      wrapped_key: toBytea(wrappedKey),
      params,
      created_at: new Date().toISOString(),
    },
    { onConflict: 'user_id,id' }
  );
  if (error) throw new VaultError('network', { cause: error });
}

/** How long sign-out waits for the key to be deleted before carrying on without it. */
export const FORGET_TIMEOUT_MS = 3_000;

/**
 * Forget the vault key on this device (sign-out), so another account signing in here can't
 * use it. Documents stay. The server copy is untouched.
 *
 * The key stops counting the moment this is called (`isVaultKeyRevoked`), so no sync run can
 * start with it; deleting it from IndexedDB is then waited for at most `timeoutMs`. Resolves to
 * whether it's deleted already; if not, the next start deletes it. Never hangs, never throws.
 */
export async function forgetVault({ timeoutMs = FORGET_TIMEOUT_MS }: { timeoutMs?: number } = {}): Promise<boolean> {
  setForgetPending(true);
  generation++;
  let forgotten = false;
  try {
    await withTimeout(forgetLocalKey(), timeoutMs, 'Forgetting the vault key');
    forgotten = true;
  } catch (err) {
    console.warn('Sync: the vault key will be removed from this device next time', err);
  }
  generation++;
  currentUserId = null;
  const auth = getAuthState();
  if (auth.status === 'signed-in') {
    currentUserId = auth.user.id;
    void check(auth.user);
  } else {
    onAuthChange(auth);
  }
  announce();
  return forgotten;
}

// ---------------------------------------------------------------------------
// Input feedback
// ---------------------------------------------------------------------------

export type RecoveryKeyInputState = 'empty' | 'incomplete' | 'typo' | 'valid';

const SYMBOLS = 28;
const INVALID_CHAR = /[^0-9A-HJKMNP-TV-Z]/;

/** Live feedback while typing a recovery key: only says 'typo' once it can be sure. */
export function checkRecoveryKeyInput(input: string): RecoveryKeyInputState {
  const chars = input.toUpperCase().replace(/[\s\-‐-―]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (chars === '') return 'empty';
  if (INVALID_CHAR.test(chars) || chars.length > SYMBOLS) return 'typo';
  if (chars.length < SYMBOLS) return 'incomplete';
  try {
    parseRecoveryKey(chars);
    return 'valid';
  } catch {
    return 'typo';
  }
}
