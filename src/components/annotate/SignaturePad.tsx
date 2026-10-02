'use client';

import { useEffect, useRef, useState } from 'react';
import type { Signature } from '@/types';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { deleteSignature, saveSignature, useSignatures } from '@/hooks/useSignatures';

interface SignaturePadProps {
  onPick: (signature: Signature) => void;
  onClose: () => void;
}

const PAD_LINE_WIDTH = 3;

function SavedSignature({ signature, onPick }: { signature: Signature; onPick: (s: Signature) => void }) {
  const url = useBlobUrl(signature.blob);
  return (
    <div className="relative">
      <button
        onClick={() => onPick(signature)}
        className="flex h-20 w-full items-center justify-center rounded-lg border border-gray-200 bg-white p-2 hover:border-blue-500"
        aria-label="Use saved signature"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url && <img src={url} alt="Saved signature" className="max-h-full max-w-full object-contain" />}
      </button>
      <button
        onClick={() => void deleteSignature(signature.id)}
        className="absolute -right-2 -top-2 flex h-6 w-6 items-center justify-center rounded-full bg-gray-700 text-xs text-white"
        aria-label="Delete saved signature"
      >
        ✕
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
        className="w-full max-w-lg rounded-t-2xl bg-white dark:bg-neutral-900 p-4 pb-safe-offset-4 sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Signature"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100">
            {showDraw ? 'Draw your signature' : 'Choose a signature'}
          </h2>
          <button
            onClick={onClose}
            className="rounded-full px-3 py-1 text-xs font-semibold text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
          >
            Cancel
          </button>
        </div>

        {showDraw ? (
          <>
            <canvas
              ref={canvasRef}
              onPointerDown={handleDown}
              onPointerMove={handleMove}
              onPointerUp={handleUp}
              onPointerCancel={handleUp}
              className="h-48 w-full touch-none rounded-lg border-2 border-dashed border-gray-300 bg-white"
              aria-label="Signature drawing area"
            />
            <div className="mt-3 flex items-center justify-between">
              <div className="flex gap-2">
                <button
                  onClick={handleClear}
                  className="rounded-full px-3 py-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
                >
                  Clear
                </button>
                {signatures.length > 0 && (
                  <button
                    onClick={() => setMode('pick')}
                    className="rounded-full px-3 py-1.5 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-neutral-800"
                  >
                    Saved signatures
                  </button>
                )}
              </div>
              <button
                onClick={handleSave}
                disabled={!hasInk}
                className="rounded-full bg-blue-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
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
              className="mt-3 w-full rounded-full border border-blue-600 py-2 text-xs font-semibold text-blue-600 dark:text-blue-400"
            >
              Draw a new signature
            </button>
          </>
        )}
      </div>
    </div>
  );
}
