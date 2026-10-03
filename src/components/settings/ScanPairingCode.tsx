'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useCamera } from '@/hooks/useCamera';
import { useEscape } from '@/hooks/useEscape';
import { PairingCodeError, parsePairingCode } from '@/lib/pairing-code';
import { PairingError, sendVaultKeyToDevice } from '@/lib/pairing-session';
import { createQrReader, type QrReader } from '@/lib/qr';

type Phase =
  | { name: 'scanning'; hint: string | null }
  | { name: 'sending' }
  | { name: 'done'; fingerprint: string }
  | { name: 'error'; message: string };

/** Time between decode attempts; jsQR on a 640 px frame takes ~10–40 ms on a phone. */
const SCAN_INTERVAL_MS = 150;

function errorText(err: unknown): string {
  return err instanceof PairingError ? err.message : 'Something went wrong. Check your connection and try again.';
}

declare global {
  interface Window {
    /** E2E dev servers only (NEXT_PUBLIC_E2E_HOOKS=1, never production): feed scanned text without a camera. */
    __quickscanScanPairingCode?: (text: string) => void;
  }
}

/**
 * Unlocked device: scan the QR code a new device shows and send it the vault key. Works with
 * the native BarcodeDetector or, on iOS Safari, jsQR on video frames (lib/qr.ts).
 */
export function ScanPairingCode({ onClose }: { onClose: () => void }) {
  const { videoRef, isActive, isSupported, error: cameraError, start, stop } = useCamera({ width: 1280, height: 720 });
  const [phase, setPhase] = useState<Phase>({ name: 'scanning', hint: null });
  const readerRef = useRef<QrReader | null>(null);
  const busyRef = useRef(false);

  useEscape(() => {
    if (phase.name !== 'sending') onClose();
  });

  const handleText = useCallback(
    async (text: string) => {
      if (busyRef.current) return;
      try {
        parsePairingCode(text);
      } catch (err) {
        // Some other QR code in view: say so (once) and keep scanning.
        const hint = err instanceof PairingCodeError ? err.message : null;
        setPhase((p) => (p.name === 'scanning' && p.hint === hint ? p : { name: 'scanning', hint }));
        return;
      }
      busyRef.current = true;
      setPhase({ name: 'sending' });
      try {
        const { fingerprint } = await sendVaultKeyToDevice(text);
        setPhase({ name: 'done', fingerprint });
      } catch (err) {
        setPhase({ name: 'error', message: errorText(err) });
      }
      stop();
    },
    [stop],
  );

  // The camera runs from opening until a code is handled; "Scan again" restarts it.
  useEffect(() => {
    void start();
    return stop;
  }, [start, stop]);

  // Decode frames while the camera runs.
  const scanning = phase.name === 'scanning';
  useEffect(() => {
    if (!scanning || !isActive) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      try {
        readerRef.current ??= await createQrReader();
        const video = videoRef.current;
        const text = video ? await readerRef.current.read(video) : null;
        if (!live) return;
        // A valid code ends scanning (and this loop, via the phase change); others are skipped.
        if (text) void handleText(text);
      } catch {
        // A frame that couldn't be read: try the next one.
      }
      if (live && !busyRef.current) timer = setTimeout(() => void loop(), SCAN_INTERVAL_MS);
    };
    void loop();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [scanning, isActive, videoRef, handleText]);

  // Dev servers started with NEXT_PUBLIC_E2E_HOOKS=1 only; NODE_ENV is inlined, so production
  // builds drop this entirely.
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' || process.env.NEXT_PUBLIC_E2E_HOOKS !== '1') return;
    window.__quickscanScanPairingCode = (text) => void handleText(text);
    return () => {
      delete window.__quickscanScanPairingCode;
    };
  }, [handleText]);

  const scanAgain = () => {
    busyRef.current = false;
    setPhase({ name: 'scanning', hint: null });
    void start();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 pb-safe-offset-4 backdrop-blur-[2px] sm:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="scan-pairing-title"
        className="max-h-full w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10"
      >
        <h2 id="scan-pairing-title" className="text-base font-bold text-gray-900 dark:text-gray-100">
          Add a device
        </h2>

        <div hidden={phase.name !== 'scanning' && phase.name !== 'sending'}>
          <p className="mt-1.5 text-sm text-gray-600 dark:text-gray-300">
            On the new device, sign in to the same account and open{' '}
            <strong>Settings → Sync → Scan from another device</strong>. Then point this camera at the code it shows.
          </p>
          <div className="relative mt-4 aspect-square w-full overflow-hidden rounded-xl bg-black">
            <video
              ref={videoRef}
              playsInline
              muted
              autoPlay
              aria-label="Camera"
              className="h-full w-full object-cover"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-[15%] rounded-2xl border-2 border-white/80"
            />
            {phase.name === 'sending' && (
              <p className="absolute inset-x-0 bottom-0 bg-black/60 py-2 text-center text-sm font-medium text-white">
                Sending the key…
              </p>
            )}
            {!isSupported && (
              <p className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">
                This browser can&apos;t use the camera. Add the device with your recovery key instead.
              </p>
            )}
            {isSupported && cameraError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
                <p role="alert" className="text-sm text-white">
                  {cameraError} You can also unlock the new device with your recovery key.
                </p>
                <button
                  type="button"
                  onClick={() => void start()}
                  className="min-h-11 rounded-lg bg-white px-4 text-sm font-semibold text-gray-900"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
          {phase.name === 'scanning' && phase.hint && (
            <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-300">
              {phase.hint}
            </p>
          )}
        </div>

        {phase.name === 'done' && (
          <div role="status" className="mt-3">
            <p className="text-sm text-gray-700 dark:text-gray-200">
              Sent. The new device unlocks in a moment — check that it shows the code{' '}
              <span
                data-testid="pairing-fingerprint"
                className="font-mono font-semibold text-gray-900 dark:text-gray-100"
              >
                {phase.fingerprint}
              </span>
              .
            </p>
          </div>
        )}

        {phase.name === 'error' && (
          <div className="mt-3">
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {phase.message}
            </p>
            <button
              type="button"
              onClick={scanAgain}
              className="mt-3 min-h-11 text-sm font-semibold text-blue-600 dark:text-blue-400"
            >
              Scan again
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={onClose}
          disabled={phase.name === 'sending'}
          className="mt-4 w-full rounded-xl bg-gray-100 py-3 text-sm font-semibold text-gray-900 hover:bg-gray-200 disabled:opacity-50 dark:bg-neutral-800 dark:text-gray-100 dark:hover:bg-neutral-700"
        >
          {phase.name === 'done' ? 'Done' : 'Cancel'}
        </button>
      </div>
    </div>
  );
}
