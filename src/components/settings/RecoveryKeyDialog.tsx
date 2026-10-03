'use client';

import { useState } from 'react';
import { useEscape } from '@/hooks/useEscape';

interface RecoveryKeyDialogProps {
  /** Shown once; lives only in the parent's state while this dialog is open. */
  recoveryKey: string;
  email: string;
  title: string;
  confirmLabel: string;
  /** Runs after the user confirms they saved the key; throw to show an error and stay open. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  errorText: (err: unknown) => string;
}

const actionButton =
  'flex min-h-11 flex-1 items-center justify-center rounded-xl bg-gray-100 px-3 text-sm font-semibold text-gray-900 hover:bg-gray-200 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700';

function recoveryKeyText(recoveryKey: string, email: string): string {
  return [
    'QuickScan recovery key',
    '',
    recoveryKey,
    '',
    `Account: ${email}`,
    `Created: ${new Date().toLocaleDateString()}`,
    '',
    'Keep this somewhere safe and private, like a password manager or a printed copy.',
    'You need it to turn on sync on a new device. Without it, and without another device',
    "where sync is on, your synced documents can't be recovered. Nobody can reset it.",
    '',
  ].join('\n');
}

/** Print just the key, via a throwaway iframe, so the app page itself isn't printed. */
function printText(text: string) {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  const pre = doc.createElement('pre');
  pre.style.cssText = 'font:16px/1.5 ui-monospace,monospace;white-space:pre-wrap;margin:2cm;';
  pre.textContent = text;
  doc.body.appendChild(pre);
  win.addEventListener('afterprint', () => frame.remove());
  win.focus();
  win.print();
  // Browsers without afterprint in iframes: drop it a while later
  setTimeout(() => frame.remove(), 60_000);
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Shows a freshly generated recovery key once, with copy / download / print, and finishes
 * only after the user confirms they saved it. Not closable by tapping the backdrop, so the
 * key isn't lost by accident; Escape and Cancel discard it (nothing is saved before confirm).
 */
export function RecoveryKeyDialog({
  recoveryKey,
  email,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  errorText,
}: RecoveryKeyDialogProps) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEscape(() => {
    if (!busy) onCancel();
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
    } catch {
      setError("Couldn't copy. Select the key and copy it, or download it instead.");
    }
  };

  const finish = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!saved || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  const text = () => recoveryKeyText(recoveryKey, email);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 pb-safe-offset-4 backdrop-blur-[2px] sm:items-center">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="recovery-key-title"
        onSubmit={(e) => void finish(e)}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10"
      >
        <h2 id="recovery-key-title" className="text-base font-bold text-gray-900 dark:text-gray-100">
          {title}
        </h2>
        <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-300">
          You need this key to turn on sync on a new device. Save it somewhere safe and private, like a password
          manager or a printed copy. It&apos;s shown only now.
        </p>

        <p
          data-testid="recovery-key"
          className="mt-4 select-all break-all rounded-xl bg-gray-100 px-3 py-4 text-center font-mono text-lg font-semibold tracking-wider text-gray-900 dark:bg-neutral-800 dark:text-gray-100"
        >
          {recoveryKey}
        </p>

        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => void copy()} className={actionButton}>
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={() => downloadText(text(), 'QuickScan recovery key.txt')} className={actionButton}>
            Download
          </button>
          <button type="button" onClick={() => printText(text())} className={actionButton}>
            Print
          </button>
        </div>

        <p className="mt-4 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:bg-amber-950/50 dark:text-amber-200">
          <strong>Don&apos;t lose it.</strong> If you lose this key and have no other device where sync is on, your
          synced documents can&apos;t be recovered — not by you, and not by us. Documents on this device stay either
          way.
        </p>

        <label className="mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-sm font-medium text-gray-900 dark:text-gray-100">
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            className="h-5 w-5 shrink-0 accent-blue-600"
          />
          I&apos;ve saved my recovery key
        </label>

        {error && (
          <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="flex-1 rounded-xl bg-gray-100 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!saved || busy}
            className="flex-1 rounded-xl bg-blue-600 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {busy ? 'Saving…' : confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
