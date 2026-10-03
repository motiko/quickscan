'use client';

import { useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { AuthError, sendSignInCode, signOut, verifySignInCode } from '@/lib/auth';
import { confirmDialog } from '@/lib/dialogs';

const inputClass =
  'w-full rounded-lg border border-gray-300 dark:border-neutral-700 bg-white dark:bg-neutral-950 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none focus:border-blue-500';
const primaryButtonClass =
  'min-h-11 shrink-0 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white disabled:opacity-50';

function errorText(err: unknown): string {
  return err instanceof AuthError ? err.message : 'Something went wrong. Check your connection and try again.';
}

/** Email → one-time code → signed in. Codes rather than links keep sign-in inside the installed PWA. */
function SignInForm() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSentTo, setCodeSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const requestCode = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await sendSignInCode(email);
      setCodeSentTo(email.trim());
      setCode('');
    });
  };

  const submitCode = (e: React.FormEvent) => {
    e.preventDefault();
    if (codeSentTo) void run(() => verifySignInCode(codeSentTo, code));
  };

  if (codeSentTo) {
    return (
      <form onSubmit={submitCode} className="px-4 py-3">
        <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
          We emailed a code to <span className="font-medium text-gray-900 dark:text-gray-100">{codeSentTo}</span>.
        </p>
        <div className="flex gap-2">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="Code"
            aria-label="Sign-in code"
            autoFocus
            className={`${inputClass} tracking-widest`}
          />
          <button type="submit" disabled={busy || !code.trim()} className={primaryButtonClass}>
            Sign in
          </button>
        </div>
        {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-3 flex gap-4 text-sm font-semibold text-blue-600 dark:text-blue-400">
          <button type="button" disabled={busy} onClick={() => void run(() => sendSignInCode(codeSentTo))}>
            Send a new code
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setCodeSentTo(null);
              setError(null);
            }}
          >
            Use another email
          </button>
        </div>
      </form>
    );
  }

  return (
    <form onSubmit={requestCode} className="px-4 py-3">
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Sign in with your email to get ready for syncing between devices. QuickScan keeps working without an account.
      </p>
      <div className="flex gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="you@example.com"
          aria-label="Email"
          required
          className={inputClass}
        />
        <button type="submit" disabled={busy || !email.trim()} className={primaryButtonClass}>
          Send code
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </form>
  );
}

/** Hidden in builds without a Supabase project; the app is fully usable signed out. */
export function AccountSettings() {
  const auth = useAuth();
  const [error, setError] = useState<string | null>(null);

  if (auth.status === 'disabled') return null;

  const handleSignOut = async () => {
    const confirmed = await confirmDialog({
      title: 'Sign out on this device?',
      message: 'Your documents stay on this device.',
      confirmLabel: 'Sign out',
    });
    if (!confirmed) return;
    setError(null);
    try {
      await signOut();
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <section className="mb-4 rounded-xl border border-gray-200 dark:border-neutral-800 bg-white dark:bg-neutral-900">
      <h2 className="px-4 pt-4 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        Account
      </h2>
      {auth.status === 'loading' && (
        <p className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">Checking sign-in…</p>
      )}
      {auth.status === 'signed-out' && <SignInForm />}
      {auth.status === 'signed-in' && (
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <span className="min-w-0">
            <span className="block text-xs text-gray-500 dark:text-gray-400">Signed in as</span>
            <span className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {auth.user.email}
            </span>
          </span>
          <button
            onClick={() => void handleSignOut()}
            className="min-h-11 shrink-0 text-sm font-semibold text-blue-600 dark:text-blue-400"
          >
            Sign out
          </button>
        </div>
      )}
      {error && <p role="alert" className="px-4 pb-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
    </section>
  );
}
