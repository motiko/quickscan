/*
 * End-to-end encryption for cloud sync, built only on WebCrypto. See each file for its byte
 * layout. No network code here: the sync engine wires this in.
 */
export { CryptoError, type CryptoErrorCode } from './errors';
export { generateVaultKey, storeVaultKey, loadVaultKey, loadTransferableVaultKey, clearVaultKey, type VaultKey } from './vault';
export {
  encryptRecord,
  decryptRecord,
  openRecord,
  type OpenedRecord,
  type RecordContext,
  type RecordVersion,
} from './records';
export { encryptFile, decryptFile, type FileContext } from './files';
export { wrapVaultKey, unwrapVaultKey, type WrapMethod, type WrapParams, type WrappedVaultKey } from './wrap';
export {
  generateRecoveryKey,
  formatRecoveryKey,
  parseRecoveryKey,
  isValidRecoveryKey,
  wrapVaultKeyWithRecoveryKey,
  unwrapVaultKeyWithRecoveryKey,
} from './recovery-key';
export {
  createPairingKeyPair,
  encodePairingPublicKey,
  decodePairingPublicKey,
  sealVaultKeyForPairing,
  openPairedVaultKey,
  type PairingKeyPair,
} from './pairing';
