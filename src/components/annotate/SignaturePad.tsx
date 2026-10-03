'use client';

import { useEffect, useRef, useState } from 'react';
import type { Signature } from '@/types';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { useEscape } from '@/hooks/useEscape';
import { useModalFocus } from '@/hooks/useModalFocus';
import { confirmDialog } from '@/lib/dialogs';
import { deleteSignature, saveSignature, useSignatures } from '@/hooks/useSignatures';

interface SignaturePadProps {
  onPick: (signature: Signature) => void;
  onClose: () => void;
}

const PAD_LINE_WIDTH = 3;

const textButton =
  'min-h-11 rounded-full px-4 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800';

async function confirmDeleteSignature(signature: Signature) {
  const confirmed = await confirmDialog({
    title: 'Delete this signature?',
    // Placed signatures reference the saved image, so they go too
    message: 'It will also disappear from every page where you placed it.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (confirmed) await deleteSignature(signature.id);
}

function SavedSignature({ signature, onPick }: { signature: Signature; onPick: (s: Signature) => void }) {
  const url = useBlobUrl(signature.blob);
  return (
    <div className="flex flex-col items-stretch">
      <button
        onClick={() => onPick(signature)}
        className="flex h-20 w-full items-center justify-center rounded-lg border border-gray-300 bg-white p-2 hover:border-blue-500"
        aria-label="Use saved signature"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url && <img src={url} alt="" className="max-h-full max-w-full object-contain" />}
      </button>
      {/* A labelled button under the signature, not a 24 px ✕ on its corner */}
      <button
        onClick={() => void confirmDeleteSignature(signature)}
        className="min-h-11 rounded-full text-sm font-semibold text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
        aria-label="Delete saved signature"
      >
        Delete
      </button>
    </div>
  );
}

/** Crop a canvas to the bounding box of its non-transparent pixels. */
function trimCanvas(source: HTMLCanvasElement): HTMLCanvasElement | null {
  const ctx = source.getContext('2d')!;
  const { width, height } = source;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 4;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(source, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export function SignaturePad({ onPick, onClose }: SignaturePadProps) {
  const signatures = useSignatures();
  const [mode, setMode] = useState<'pick' | 'draw'>('pick');
  const [hasInk, setHasInk] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);

  const showDraw = mode === 'draw' || signatures.length === 0;
  useEscape(onClose);
  // A modal layer over the annotation editor (UX-008)
  const layerRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useModalFocus(layerRef, cancelRef);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!showDraw || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = PAD_LINE_WIDTH;
    ctx.strokeStyle = '#111827';
  }, [showDraw]);

  const pointFor = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const handleDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = pointFor(e);
    lastPoint.current = p;
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.beginPath();
    ctx.arc(p.x, p.y, PAD_LINE_WIDTH / 2, 0, Math.PI * 2);
    ctx.fillStyle = '#111827';
    ctx.fill();
    setHasInk(true);
  };

  const handleMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!lastPoint.current) return;
    const p = pointFor(e);
    const ctx = e.currentTarget.getContext('2d')!;
    ctx.beginPath();
    ctx.moveTo(lastPoint.current.x, lastPoint.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    lastPoint.current = p;
  };

  const handleUp = () => {
    lastPoint.current = null;
  };

  const handleClear = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.getContext('2d')!.clearRect(0, 0, canvas.width, canvas.height);
    setHasInk(false);
  };

  const handleSave = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const trimmed = trimCanvas(canvas);
    if (!trimmed) return;
    const blob = await new Promise<Blob | null>((r) => trimmed.toBlob(r, 'image/png'));
    if (!blob) return;
    const signature = await saveSignature(blob, trimmed.width, trimmed.height);
    onPick(signature);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center" onClick={onClose}>
      <div
        ref={layerRef}
        className="w-full max-w-lg rounded-t-2xl bg-white dark:bg-neutral-900 p-4 pb-safe-offset-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Signature"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-base font-bold text-gray-900 dark:text-gray-100">
            {showDraw ? 'Draw your signature' : 'Choose a signature'}
          </h2>
          <button ref={cancelRef} onClick={onClose} className={`${textButton} -mr-2`}>
            Cancel
          </button>
        </div>

        {showDraw ? (
          <>
            <div className="relative rounded-lg bg-white">
              <canvas
                ref={canvasRef}
                onPointerDown={handleDown}
                onPointerMove={handleMove}
                onPointerUp={handleUp}
                onPointerCancel={handleUp}
                className="block h-48 w-full touch-none rounded-lg border-2 border-dashed border-gray-400 bg-white"
                aria-label="Signature drawing area"
              />
              {!hasInk && (
                <p
                  id="signature-hint"
                  className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-gray-600"
                >
                  Sign here with your finger
                </p>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
              <div className="-ml-4 flex flex-wrap">
                <button onClick={handleClear} className={textButton}>
                  Clear
                </button>
                {signatures.length > 0 && (
                  <button onClick={() => setMode('pick')} className={textButton}>
                    Saved signatures
                  </button>
                )}
              </div>
              <button
                onClick={handleSave}
                disabled={!hasInk}
                // UX-012: the hint in the drawing area says why it's disabled
                aria-describedby={hasInk ? undefined : 'signature-hint'}
                className="min-h-11 rounded-full bg-blue-600 px-5 text-sm font-semibold text-white hover:bg-blue-700 disabled:bg-gray-200 disabled:text-gray-600 dark:disabled:bg-neutral-800 dark:disabled:text-gray-400"
              >
                Save &amp; place
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              {signatures.map((s) => (
                <SavedSignature key={s.id} signature={s} onPick={onPick} />
              ))}
            </div>
            <button
              onClick={() => {
                setHasInk(false);
                setMode('draw');
              }}
              className="mt-3 min-h-11 w-full rounded-full border border-blue-600 text-sm font-semibold text-blue-600 dark:border-blue-400 dark:text-blue-400"
            >
              Draw a new signature
            </button>
          </>
        )}
      </div>
    </div>
  );
}
