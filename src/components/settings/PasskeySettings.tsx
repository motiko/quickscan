'use client';

import { useCallback, useEffect, useState } from 'react';
import { alertDialog, confirmDialog, promptDialog } from '@/lib/dialogs';
import {
  PASSKEYS_CHANGED_EVENT,
  PasskeyError,
  addPasskey,
  finishPasskey,
  getPasskeySupport,
  listPasskeys,
  passkeysForThisSite,
  removePasskey,
  renamePasskey,
  unlockWithPasskey,
  type PasskeyInfo,
  type PasskeySupport,
} from '@/lib/passkeys';
import { VaultError } from '@/lib/vault-session';

/*
 * Passkeys (WebAuthn PRF) as an extra way to unlock sync; see lib/passkeys.ts. WebAuthn
 * prompts need a recent tap, so the passkey list is loaded ahead of time and each prompt is
 * started directly from a button or dialog press.
 */

const primaryButtonClass =
  'min-h-11 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50';
const linkButtonClass = 'min-h-11 text-sm font-semibold text-blue-600 dark:text-blue-400 disabled:opacity-50';
const hintClass = 'text-xs text-gray-500 dark:text-gray-400';

function passkeyErrorText(err: unknown): string {
  return err instanceof PasskeyError || err instanceof VaultError
    ? err.message
    : 'Something went wrong. Check your connection and try again.';
}

const UNSUPPORTED_HINT =
  "This browser can't unlock sync with a passkey. Use your recovery key or a QR code from another device.";

function usePasskeySupport(): PasskeySupport | null {
  const [support, setSupport] = useState<PasskeySupport | null>(null);
  useEffect(() => {
    let live = true;
    void getPasskeySupport().then((s) => live && setSupport(s));
    return () => {
      live = false;
    };
  }, []);
  return support;
}

/** The account's passkeys, reloaded whenever they change; null while loading or offline. */
function usePasskeys(): PasskeyInfo[] | null {
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      listPasskeys().then(
        (list) => live && setPasskeys(list),
        () => live && setPasskeys(null)
      );
    void load();
    window.addEventListener(PASSKEYS_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(PASSKEYS_CHANGED_EVENT, load);
    };
  }, []);
  return passkeys;
}

/**
 * Add a passkey from a button press, with dialogs for the outcome. Handles platforms that
 * need a second prompt from a fresh tap (iOS/Safari) by asking for it.
 */
async function runAddPasskey(excludeIds: string[]): Promise<boolean> {
  try {
    let added: PasskeyInfo;
    try {
      added = await addPasskey({ excludeIds });
    } catch (err) {
      if (!(err instanceof PasskeyError && err.code === 'needs-confirmation' && err.pending)) throw err;
      const go = await confirmDialog({
        title: 'Finish adding your passkey',
        message: 'Confirm the new passkey once more so it can unlock sync.',
        confirmLabel: 'Continue',
      });
      if (!go) return false;
      added = await finishPasskey(err.pending);
    }
    await alertDialog({
      title: 'Passkey added',
      message: `“${added.label}” can now unlock sync on new devices that have this passkey. Keep your recovery key too.`,
    });
    return true;
  } catch (err) {
    if (err instanceof PasskeyError && err.code === 'cancelled') return false;
    await alertDialog({
      title: err instanceof PasskeyError && err.code === 'unsupported' ? "Passkeys can't unlock sync here" : "Couldn't add the passkey",
      message: passkeyErrorText(err),
    });
    return false;
  }
}

/** After "Turn on sync" on the first device: offer a passkey, skippable. */
export async function suggestPasskey(): Promise<void> {
  if ((await getPasskeySupport()) === 'unsupported') return;
  const yes = await confirmDialog({
    title: 'Also add a passkey for faster unlock?',
    message:
      'With a passkey, your other devices that share your password manager (iCloud Keychain, Google Password Manager…) can unlock sync with Face ID or a fingerprint. Your recovery key keeps working.',
    confirmLabel: 'Add passkey',
    cancelLabel: 'Not now',
  });
  if (yes) await runAddPasskey([]);
}

/** On a locked device: "Unlock with a passkey" when the account has one for this site. */
export function UnlockWithPasskey() {
  const support = usePasskeySupport();
  const passkeys = usePasskeys();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!passkeys || passkeys.length === 0 || support === null) return null;
  const here = passkeysForThisSite(passkeys);
  if (here.length === 0) {
    return (
      <p className={`mb-3 ${hintClass}`}>
        Your passkeys were added on another web address ({passkeys[0].rpId}) and only work there.
      </p>
    );
  }
  if (support === 'unsupported') return <p className={`mb-3 ${hintClass}`}>{UNSUPPORTED_HINT}</p>;

  const unlock = async () => {
    setBusy(true);
    setError(null);
    try {
      await unlockWithPasskey(here);
    } catch (err) {
      setError(passkeyErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3">
      <button type="button" onClick={() => void unlock()} disabled={busy} className={primaryButtonClass}>
        Unlock with a passkey
      </button>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}

/** On an unlocked device: the account's passkeys, with add, rename and remove. */
export function ManagePasskeys() {
  const support = usePasskeySupport();
  const passkeys = usePasskeys();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = typeof location === 'undefined' ? '' : location.hostname;

  const add = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await runAddPasskey((passkeys ?? []).map((p) => p.id));
    } finally {
      setBusy(false);
    }
  }, [passkeys]);

  const rename = async (passkey: PasskeyInfo) => {
    const label = await promptDialog({
      title: 'Rename passkey',
      label: 'Name',
      defaultValue: passkey.label,
      maxLength: 200,
      confirmLabel: 'Rename',
    });
    if (label === null || label.trim() === '' || label.trim() === passkey.label) return;
    try {
      await renamePasskey(passkey.id, label);
    } catch (err) {
      setError(passkeyErrorText(err));
    }
  };

  const remove = async (passkey: PasskeyInfo) => {
    const confirmed = await confirmDialog({
      title: `Remove “${passkey.label}”?`,
      message:
        "It won't unlock sync on new devices any more. Devices where sync is already on stay unlocked, and your recovery key keeps working.",
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!confirmed) return;
    try {
      await removePasskey(passkey);
    } catch (err) {
      setError(passkeyErrorText(err));
    }
  };

  return (
    <div className="mt-2 border-t border-gray-100 pt-2 dark:border-neutral-800">
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100">Passkeys</p>
      {passkeys && passkeys.length > 0 ? (
        <ul className="mt-1" aria-label="Passkeys">
          {passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm text-gray-900 dark:text-gray-100">{p.label}</p>
                <p className={hintClass}>
                  Added {new Date(p.createdAt).toLocaleDateString()}
                  {p.rpId !== host && ` · works on ${p.rpId} only`}
                </p>
              </div>
              <div className="flex shrink-0 gap-4">
                <button onClick={() => void rename(p)} className={linkButtonClass} aria-label={`Rename ${p.label}`}>
                  Rename
                </button>
                <button
                  onClick={() => void remove(p)}
                  className="min-h-11 text-sm font-semibold text-red-600 dark:text-red-400"
                  aria-label={`Remove ${p.label}`}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className={`mt-1 ${hintClass}`}>
          Unlock sync on new devices with Face ID or a fingerprint, through a passkey synced by your password manager.
        </p>
      )}
      {support === 'unsupported' ? (
        <p className={`mt-1 ${hintClass}`}>{UNSUPPORTED_HINT}</p>
      ) : (
        <button onClick={() => void add()} disabled={busy || support === null} className={linkButtonClass}>
          Add a passkey
        </button>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
