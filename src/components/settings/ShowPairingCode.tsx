'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEscape } from '@/hooks/useEscape';
import { alertDialog } from '@/lib/dialogs';
import { PAIRING_POLL_MS, PAIRING_TTL_MS, PairingError, PairingRequest } from '@/lib/pairing-session';
import { drawQrCode } from '@/lib/qr';

type Phase =
  | { name: 'creating' }
  | { name: 'waiting'; request: PairingRequest }
  | { name: 'expired' }
  | { name: 'error'; message: string };

const QR_PX = 264;

function errorText(err: unknown): string {
  return err instanceof PairingError ? err.message : 'Something went wrong. Check your connection and try again.';
}

function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function QrCanvas({ text }: { text: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) void drawQrCode(ref.current, text, QR_PX * 2);
  }, [text]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label="Pairing QR code"
      className="mx-auto block h-[264px] w-[264px] max-w-full rounded-xl bg-white [image-rendering:pixelated]"
    />
  );
}

/**
 * New device: show a QR code for an unlocked device to scan, wait for the vault key and
 * unlock. Cancel, Escape or unmount deletes the request; the private key never leaves the
 * PairingRequest.
 */
export function ShowPairingCode({ onClose }: { onClose: () => void }) {
  const [phase, setPhase] = useState<Phase>({ name: 'creating' });
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);

  const close = useCallback(() => {
    if (phase.name === 'waiting') void phase.request.cancel();
    onClose();
  }, [phase, onClose]);
  useEscape(close);

  // Create a request per attempt; cancel it when the attempt ends early.
  useEffect(() => {
    let live = true;
    let request: PairingRequest | null = null;
    PairingRequest.create().then(
      (created) => {
        request = created;
        if (live) setPhase({ name: 'waiting', request: created });
        else void created.cancel();
      },
      (err) => {
        if (live) setPhase({ name: 'error', message: errorText(err) });
      },
    );
    return () => {
      live = false;
      void request?.cancel();
    };
  }, [attempt]);

  // Poll for the answer (one check at a time) and tick the countdown.
  useEffect(() => {
    if (phase.name !== 'waiting') return;
    const { request } = phase;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const status = await request.poll();
        if (status === 'paired') {
          // Unlocking re-renders the settings without this dialog, so it may be gone already.
          void alertDialog({
            title: 'Sync is on for this device',
            message: 'Your other device sent the key. Your synced documents will appear here.',
          });
          if (live) onClose();
          return;
        }
        if (!live) return;
        if (status === 'expired') {
          setPhase({ name: 'expired' });
          return;
        }
      } catch (err) {
        if (!live) return;
        if (!(err instanceof PairingError && err.code === 'network')) {
          setPhase({ name: 'error', message: errorText(err) });
          return;
        }
        // A failed check: keep trying until the code expires.
      }
      timer = setTimeout(() => void tick(), PAIRING_POLL_MS);
    };
    timer = setTimeout(() => void tick(), PAIRING_POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [phase, onClose]);

  const remaining = phase.name === 'waiting' ? phase.request.expiresAt - now : 0;
  const newCode = () => {
    setPhase({ name: 'creating' });
    setAttempt((n) => n + 1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 pb-safe-offset-4 backdrop-blur-[2px] sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="pairing-code-title"
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10"
      >
        <h2 id="pairing-code-title" className="text-base font-bold text-gray-900 dark:text-gray-100">
          Scan from another device
        </h2>
        <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-300">
          On a device where sync is on, open <strong>Settings → Sync → Add a device</strong> and scan this code. Both
          devices must be signed in to the same account.
        </p>

        <div className="mt-4 min-h-[264px]">
          {phase.name === 'creating' && (
            <p className="flex h-[264px] items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              Creating a code…
            </p>
          )}
          {phase.name === 'waiting' && (
            <>
              <QrCanvas text={phase.request.code} />
              {process.env.NODE_ENV !== 'production' && process.env.NEXT_PUBLIC_E2E_HOOKS === '1' && (
                <output data-testid="pairing-code" hidden>
                  {phase.request.code}
                </output>
              )}
              <p className="mt-3 text-center text-sm text-gray-600 dark:text-gray-300">
                Code{' '}
                <span
                  data-testid="pairing-fingerprint"
                  className="font-mono font-semibold text-gray-900 dark:text-gray-100"
                >
                  {phase.request.fingerprint}
                </span>{' '}
                — the other device shows the same.
              </p>
              <p className="mt-1 text-center text-xs text-gray-500 dark:text-gray-400" aria-live="off">
                Waiting for your other device · expires in{' '}
                <time className="font-mono tabular-nums">{formatRemaining(remaining)}</time>
              </p>
              <div
                className="mx-auto mt-2 h-1 w-40 overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-800"
                role="progressbar"
                aria-label="Time left"
                aria-valuemin={0}
                aria-valuemax={PAIRING_TTL_MS / 1000}
                aria-valuenow={Math.max(0, Math.round(remaining / 1000))}
              >
                <div
                  className="h-full bg-blue-600 motion-safe:transition-[width] motion-safe:duration-1000 motion-safe:ease-linear"
                  style={{ width: `${Math.max(0, Math.min(100, (remaining / PAIRING_TTL_MS) * 100))}%` }}
                />
              </div>
            </>
          )}
          {phase.name === 'expired' && (
            <div className="flex h-[264px] flex-col items-center justify-center gap-3 text-center">
              <p role="alert" className="text-sm text-gray-700 dark:text-gray-200">
                This code has expired.
              </p>
              <button
                type="button"
                onClick={newCode}
                className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white"
              >
                Show a new code
              </button>
            </div>
          )}
          {phase.name === 'error' && (
            <div className="flex h-[264px] flex-col items-center justify-center gap-3 text-center">
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                {phase.message}
              </p>
              <button
                type="button"
                onClick={newCode}
                className="min-h-11 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white"
              >
                Show a new code
              </button>
            </div>
          )}
        </div>

        <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
          The code holds no secrets: your other device uses it to encrypt the sync key for this device only.
        </p>

        <button
          type="button"
          onClick={close}
          className="mt-4 w-full rounded-xl bg-gray-100 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-200 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
