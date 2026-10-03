import { db } from '@/lib/db';
import { CryptoError } from './errors';

/*
 * The vault key on this device.
 *
 * One random AES-256-GCM key per user encrypts every synced record and file. It is created
 * on the first device that turns on sync, leaves the device only wrapped (wrap.ts) or sealed
 * to a pairing device (pairing.ts), and is kept here in IndexedDB so the device unlocks once.
 *
 * Non-extractability. Two kinds of handles exist:
 *   - The *stored* key (`loadVaultKey`) is a non-extractable CryptoKey with usages
 *     encrypt/decrypt only. Daily encryption uses this one; its bytes can't be exported.
 *   - *Transient* extractable keys come from `generateVaultKey`, `unwrapVaultKey`,
 *     `openPairedVaultKey` and `loadTransferableVaultKey`. They exist only to be wrapped,
 *     sealed or stored, are never persisted, and should be dropped right after use.
 * WebCrypto can't wrap a non-extractable key, yet an unlocked device must still be able to
 * seal the vault key for a new device (pairing) or wrap it again (adding a passkey). So
 * `storeVaultKey` also keeps an *escrow*: the vault key wrapped with AES-KW under a second,
 * device-local, non-extractable key. `loadTransferableVaultKey` unwraps that escrow into a
 * transient extractable key. The raw key bytes never appear in JavaScript at any point —
 * every hop is generateKey / wrapKey / unwrapKey inside WebCrypto — and nothing ever
 * persists them in the clear.
 *
 * What this protects: the key can't leak through a stray export, a log line, a debug dump
 * of IndexedDB values or a careless serializer. What it can't: code running in this origin
 * (XSS) can use the key, and could unwrap the escrow too. That's inherent: a device that can
 * pair others without asking for the recovery key must be able to produce the key.
 *
 * Stored in `syncMeta` under 'vaultKey' (never synced; structured clone keeps CryptoKeys,
 * including their non-extractable flag).
 */

const VAULT_KEY_META = 'vaultKey';

interface StoredVaultRow {
  v: 1;
  /** Matches `records.key_version`; bumped by a future key rotation. */
  keyVersion: number;
  /** AES-256-GCM, non-extractable, encrypt/decrypt. */
  key: CryptoKey;
  /** AES-256-KW, non-extractable, device-local; only ever unwraps `escrow`. */
  escrowKey: CryptoKey;
  /** The vault key wrapped by `escrowKey` (AES-KW, 40 bytes). */
  escrow: Uint8Array<ArrayBuffer>;
}

export interface VaultKey {
  /** Non-extractable; use for encryptRecord / decryptRecord / encryptFile / decryptFile. */
  key: CryptoKey;
  keyVersion: number;
}

const AES_GCM = { name: 'AES-GCM', length: 256 } as const;

/**
 * A fresh random vault key — **extractable**, for the first device only. Wrap it with the
 * recovery key, pass it to `storeVaultKey`, then drop it.
 */
export function generateVaultKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES_GCM, true, ['encrypt', 'decrypt']) as Promise<CryptoKey>;
}

/**
 * Keep the vault key on this device. `transientKey` must be extractable (from
 * `generateVaultKey`, an unwrap or a pairing); what's stored is a non-extractable copy plus
 * the escrow. Returns the stored, non-extractable key. Replaces any key stored before.
 */
export async function storeVaultKey(transientKey: CryptoKey, opts: { keyVersion?: number } = {}): Promise<VaultKey> {
  if (!transientKey.extractable) {
    throw new TypeError('storeVaultKey needs the transient (extractable) key, not a stored one');
  }
  const escrowKey = (await crypto.subtle.generateKey({ name: 'AES-KW', length: 256 }, false, [
    'wrapKey',
    'unwrapKey',
  ])) as CryptoKey;
  const escrow = new Uint8Array(await crypto.subtle.wrapKey('raw', transientKey, escrowKey, 'AES-KW'));
  const key = await crypto.subtle.unwrapKey('raw', escrow, escrowKey, 'AES-KW', AES_GCM, false, [
    'encrypt',
    'decrypt',
  ]);
  const keyVersion = opts.keyVersion ?? 1;
  const row: StoredVaultRow = { v: 1, keyVersion, key, escrowKey, escrow };
  await db.syncMeta.put({ key: VAULT_KEY_META, value: row });
  return { key, keyVersion };
}

async function readRow(): Promise<StoredVaultRow | null> {
  const row = (await db.syncMeta.get(VAULT_KEY_META))?.value as StoredVaultRow | undefined;
  if (!row) return null;
  if (row.v !== 1 || !(row.key instanceof CryptoKey) || !(row.escrowKey instanceof CryptoKey)) {
    throw new CryptoError('malformed', 'Stored vault key is unreadable');
  }
  return row;
}

/** The device's non-extractable vault key, or null if this device isn't unlocked. */
export async function loadVaultKey(): Promise<VaultKey | null> {
  const row = await readRow();
  return row && { key: row.key, keyVersion: row.keyVersion };
}

/**
 * A transient **extractable** copy of the stored vault key, for `sealVaultKeyForPairing` or
 * `wrapVaultKey` on an unlocked device. Never persist it; drop it right after use.
 */
export async function loadTransferableVaultKey(): Promise<CryptoKey | null> {
  const row = await readRow();
  if (!row) return null;
  return crypto.subtle.unwrapKey('raw', row.escrow, row.escrowKey, 'AES-KW', AES_GCM, true, ['encrypt', 'decrypt']);
}

/** Forget the vault key on this device (sign-out, reset). */
export async function clearVaultKey(): Promise<void> {
  await db.syncMeta.delete(VAULT_KEY_META);
}
