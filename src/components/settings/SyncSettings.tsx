'use client';

import { useCallback, useState } from 'react';
import { useVault } from '@/hooks/useVault';
import { generateRecoveryKey } from '@/lib/crypto';
import { alertDialog, confirmDialog } from '@/lib/dialogs';
import {
  VaultError,
  checkRecoveryKeyInput,
  createVault,
  refreshVault,
  replaceRecoveryKey,
  unlockVault,
} from '@/lib/vault-session';
import { RecoveryKeyDialog } from './RecoveryKeyDialog';
import { ScanPairingCode } from './ScanPairingCode';
import { ShowPairingCode } from './ShowPairingCode';

const inputClass =
  'w-full rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 font-mono text-sm uppercase text-gray-900 dark:text-gray-100 outline-none focus:border-blue-500';
const primaryButtonClass =
  'min-h-11 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const linkButtonClass = 'min-h-11 text-sm font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-50';
const hintClass = 'text-xs text-gray-500 dark:text-gray-400';

function errorText(err: unknown): string {
  return err instanceof VaultError ? err.message : 'Something went wrong. Check your connection and try again.';
}

/** Turn sync on: generate a recovery key, show it once, then create the vault. */
function TurnOnSync({ email }: { email: string }) {
  // The recovery key exists only here, and only while the dialog is open.
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const finish = async (key: string) => {
    const result = await createVault(key);
    setRecoveryKey(null);
    if (result === 'exists') {
      await alertDialog({
        title: 'Sync is already on for your account',
        message:
          'Another device turned it on a moment ago. Unlock this device with the recovery key that device showed you.',
      });
    }
  };

  return (
    <div className="px-4 py-3">
      <p className={`mb-3 ${hintClass}`}>
        Keep your documents in sync between your devices. They&apos;re encrypted on this device before upload, so only
        your devices can read them.
      </p>
      <button onClick={() => setRecoveryKey(generateRecoveryKey())} className={primaryButtonClass}>
        Turn on sync
      </button>
      {recoveryKey && (
        <RecoveryKeyDialog
          recoveryKey={recoveryKey}
          email={email}
          title="Save your recovery key"
          confirmLabel="Turn on sync"
          onConfirm={() => finish(recoveryKey)}
          onCancel={() => setRecoveryKey(null)}
          errorText={errorText}
        />
      )}
    </div>
  );
}

/** Unlock this device by scanning from an unlocked device (QR pairing) or with the recovery key. */
function UnlockSync() {
  const [pairing, setPairing] = useState(false);
  const closePairing = useCallback(() => setPairing(false), []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputState = checkRecoveryKeyInput(input);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (inputState !== 'valid') return;
    setBusy(true);
    setError(null);
    try {
      await unlockVault(input);
      setInput('');
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const typo = inputState === 'typo';
  return (
    <>
      <form onSubmit={(e) => void submit(e)} className="px-4 py-3">
        <p className="mb-1 text-sm font-medium text-gray-900 dark:text-gray-100">Unlock sync on this device</p>
        <p className={`mb-3 ${hintClass}`}>
          Sync is on for your account. Scan a code with a device where sync is already on, or enter the recovery key you
          saved when you turned it on.
        </p>
        <button type="button" onClick={() => setPairing(true)} className={`mb-3 ${primaryButtonClass}`}>
          Scan from another device
        </button>
        <p className={`mb-2 ${hintClass}`}>Or use your recovery key:</p>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setError(null);
            }}
            placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
            aria-label="Recovery key"
            aria-invalid={typo}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className={`${inputClass} ${typo ? 'border-red-500 dark:border-red-500' : ''}`}
          />
          <button type="submit" disabled={busy || inputState !== 'valid'} className={primaryButtonClass}>
            Unlock
          </button>
        </div>
        {typo && !error && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
            That doesn&apos;t look right — check for a typo. Recovery keys use the digits 0–9 and letters A–Z (no I, L,
            O or U).
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
        {/* Step 7 (passkeys) adds "Unlock with a passkey" here for accounts with a 'passkey'
          vault_keys row. */}
      </form>
      {/* Outside the form, so the dialog's buttons can't submit it. */}
      {pairing && <ShowPairingCode onClose={closePairing} />}
    </>
  );
}

/** This device holds the vault key. */
function SyncOn({ email }: { email: string }) {
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const closeScanner = useCallback(() => setScanning(false), []);

  const startReplace = async () => {
    const confirmed = await confirmDialog({
      title: 'Create a new recovery key?',
      message:
        'Your current recovery key stops working once you save the new one. Devices where sync is already on stay unlocked.',
      confirmLabel: 'Create key',
    });
    if (confirmed) setRecoveryKey(generateRecoveryKey());
  };

  const finish = async (key: string) => {
    await replaceRecoveryKey(key);
    setRecoveryKey(null);
    await alertDialog({ title: 'New recovery key saved', message: 'Your old recovery key no longer works.' });
  };

  return (
    <div className="px-4 py-3">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Sync is on for this device</p>
      {/* Step 6: the sync engine's status (last synced, pending changes, errors) goes here. */}
      <div className="mt-1 flex flex-wrap gap-x-5">
        <button onClick={() => setScanning(true)} className={linkButtonClass}>
          Add a device
        </button>
        <button onClick={() => void startReplace()} className={linkButtonClass}>
          Create a new recovery key
        </button>
      </div>
      {/* Step 7: "Add a passkey" goes here. */}
      {scanning && <ScanPairingCode onClose={closeScanner} />}
      {recoveryKey && (
        <RecoveryKeyDialog
          recoveryKey={recoveryKey}
          email={email}
          title="Save your new recovery key"
          confirmLabel="Use new key"
          onConfirm={() => finish(recoveryKey)}
          onCancel={() => setRecoveryKey(null)}
          errorText={errorText}
        />
      )}
    </div>
  );
}

/** The Sync area under the signed-in account; only rendered while signed in. */
export function SyncSettings({ email }: { email: string }) {
  const vault = useVault();

  return (
    <div className="border-t border-gray-100 dark:border-neutral-800">
      <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">Sync</h3>
      {vault.status === 'checking' && <p className={`px-4 py-3 ${hintClass}`}>Checking sync…</p>}
      {vault.status === 'no-vault' && <TurnOnSync email={email} />}
      {vault.status === 'locked' && <UnlockSync />}
      {vault.status === 'unlocked' && <SyncOn email={email} />}
      {vault.status === 'error' && (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <p role="alert" className="text-xs text-red-600 dark:text-red-400">
            {vault.message}
          </p>
          <button onClick={() => void refreshVault()} className={`shrink-0 ${linkButtonClass}`}>
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
