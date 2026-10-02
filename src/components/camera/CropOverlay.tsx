'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Point, Quad } from '@/types';
import { warpPerspective } from '@/lib/image-processing';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { useScannerWorker } from '@/hooks/useScannerWorker';
import { useEscape } from '@/hooks/useEscape';
import { alertDialog } from '@/lib/dialogs';

/** Inset (px) between the image and the edge of the view area, so handles on
 * the image border stay fully visible and touchable. */
const VIEW_PADDING = 28;

type DragState = {
  kind: 'corner' | 'edge';
  /** Corner index, or edge index (edge i connects corner i and i+1). */
  index: number;
  pointerId: number;
  /** Pointer position at drag start, normalized and unclamped. */
  start: Point;
  startCorners: Quad;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** True if the quad is strictly convex (all turns in the same direction). */
function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = q[i];
    const b = q[(i + 1) % 4];
    const c = q[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) < 1e-6) return false;
    const s = Math.sign(cross);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

interface CropOverlayProps {
  imageBlob: Blob;
  initialCorners?: Quad | null;
  onApplyCrop: (warpedBlob: Blob, corners: Quad) => void;
  onCancel: () => void;
}

export function CropOverlay({
  imageBlob,
  initialCorners,
  onApplyCrop,
  onCancel,
}: CropOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageUrl = useBlobUrl(imageBlob);
  useEscape(onCancel);

  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  // Track container dimensions via ResizeObserver
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Normalized corners [0..1]
  const [corners, setCorners] = useState<Quad>(() => {
    if (initialCorners) {
      return initialCorners;
    }
    // Default 88% inset rectangle
    return [
      { x: 0.06, y: 0.06 },
      { x: 0.94, y: 0.06 },
      { x: 0.94, y: 0.94 },
      { x: 0.06, y: 0.94 },
    ];
  });

  const [drag, setDrag] = useState<DragState | null>(null);
  const activeCorner = drag?.kind === 'corner' ? drag.index : null;
  const [isProcessing, setIsProcessing] = useState(false);

  const { detect } = useScannerWorker();
  const [isDetecting, setIsDetecting] = useState(false);
  const autoDetectTriggeredRef = useRef(false);

  const handleAutoDetect = useCallback(async () => {
    if (isDetecting || naturalSize.width === 0 || !imageUrl) return;
    setIsDetecting(true);
    try {
      const maxDim = 600;
      const scale = Math.min(maxDim / naturalSize.width, maxDim / naturalSize.height, 1);
      const dw = Math.round(naturalSize.width * scale);
      const dh = Math.round(naturalSize.height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = dw;
      canvas.height = dh;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        const img = new Image();
        img.src = imageUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });
        ctx.drawImage(img, 0, 0, dw, dh);
        const imgData = ctx.getImageData(0, 0, dw, dh);
        const res = await detect(imgData, { detector: 'classical', track: false });
        if (res.normalizedCorners) {
          setCorners(res.normalizedCorners);
        }
      }
    } catch (err) {
      console.warn('Auto detect failed:', err);
    } finally {
      setIsDetecting(false);
    }
  }, [detect, isDetecting, naturalSize, imageUrl]);

  // If corners were not passed from camera, run auto-detect once image loads
  useEffect(() => {
    if (!initialCorners && naturalSize.width > 0 && !autoDetectTriggeredRef.current) {
      autoDetectTriggeredRef.current = true;
      handleAutoDetect();
    }
  }, [initialCorners, naturalSize, handleAutoDetect]);

  // Compute displayed image bounding box inside container from state
  const bounds = useMemo(() => {
    if (containerSize.width === 0 || naturalSize.width === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const availW = Math.max(1, containerSize.width - VIEW_PADDING * 2);
    const availH = Math.max(1, containerSize.height - VIEW_PADDING * 2);
    const aspect = naturalSize.width / naturalSize.height;
    const containerAspect = availW / availH;

    let width = 0;
    let height = 0;
    let x = 0;
    let y = 0;

    if (containerAspect > aspect) {
      height = availH;
      width = height * aspect;
    } else {
      width = availW;
      height = width / aspect;
    }
    x = (containerSize.width - width) / 2;
    y = (containerSize.height - height) / 2;

    return { x, y, width, height };
  }, [containerSize, naturalSize]);

  // Load natural dimensions
  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
  };

  // Convert client coordinates to normalized image coordinates (unclamped)
  const clientToNormalized = useCallback(
    (clientX: number, clientY: number): Point => {
      if (!containerRef.current || bounds.width === 0 || bounds.height === 0) {
        return { x: 0, y: 0 };
      }
      const containerRect = containerRef.current.getBoundingClientRect();
      return {
        x: (clientX - containerRect.left - bounds.x) / bounds.width,
        y: (clientY - containerRect.top - bounds.y) / bounds.height,
      };
    },
    [bounds]
  );

  // Pointer drag events. Movement is applied as a delta from the grab point,
  // so the handle never jumps to sit under the fingertip.
  const handlePointerDown = (kind: DragState['kind'], index: number, e: React.PointerEvent) => {
    if (drag) return; // ignore a second finger
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({
      kind,
      index,
      pointerId: e.pointerId,
      start: clientToNormalized(e.clientX, e.clientY),
      startCorners: corners,
    });
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();

    const pos = clientToNormalized(e.clientX, e.clientY);
    let dx = pos.x - drag.start.x;
    let dy = pos.y - drag.start.y;
    const next = [...drag.startCorners] as Quad;

    if (drag.kind === 'corner') {
      const c = drag.startCorners[drag.index];
      next[drag.index] = { x: clamp01(c.x + dx), y: clamp01(c.y + dy) };
    } else {
      // Move both endpoints of the edge; clamp the shared delta so neither
      // endpoint leaves the image (keeps the edge's angle intact).
      const i = drag.index;
      const j = (i + 1) % 4;
      const a = drag.startCorners[i];
      const b = drag.startCorners[j];
      dx = Math.max(-Math.min(a.x, b.x), Math.min(1 - Math.max(a.x, b.x), dx));
      dy = Math.max(-Math.min(a.y, b.y), Math.min(1 - Math.max(a.y, b.y), dy));
      next[i] = { x: a.x + dx, y: a.y + dy };
      next[j] = { x: b.x + dx, y: b.y + dy };
    }
    // Refuse moves that would fold the quad into a bow-tie or concave shape;
    // the handle simply stops at the last valid position.
    if (isConvex(next)) setCorners(next);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    setDrag(null);
  };

  const handleResetFull = () => {
    setCorners([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]);
  };

  const handleApply = async () => {
    if (isProcessing || naturalSize.width === 0) return;
    setIsProcessing(true);

    try {
      const absoluteCorners: Quad = [
        { x: corners[0].x * naturalSize.width, y: corners[0].y * naturalSize.height },
        { x: corners[1].x * naturalSize.width, y: corners[1].y * naturalSize.height },
        { x: corners[2].x * naturalSize.width, y: corners[2].y * naturalSize.height },
        { x: corners[3].x * naturalSize.width, y: corners[3].y * naturalSize.height },
      ];

      const warped = await warpPerspective(imageBlob, absoluteCorners);
      onApplyCrop(warped, absoluteCorners);
    } catch (err) {
      console.error('Failed to warp perspective:', err);
      void alertDialog({ title: 'Couldn’t apply the crop', message: 'Please try adjusting the corners.' });
      setIsProcessing(false);
    }
  };

  // Screen coordinates for SVG
  const screenCorners = corners.map((c) => ({
    x: bounds.x + c.x * bounds.width,
    y: bounds.y + c.y * bounds.height,
  }));

  const svgPolygonPoints = screenCorners.map((p) => `${p.x},${p.y}`).join(' ');
  const cornerNames = ['Top-Left', 'Top-Right', 'Bottom-Right', 'Bottom-Left'];
  const edgeNames = ['Top', 'Right', 'Bottom', 'Left'];
  const edgeHandles = screenCorners.map((p, i) => {
    const q = screenCorners[(i + 1) % 4];
    return {
      x: (p.x + q.x) / 2,
      y: (p.y + q.y) / 2,
      angle: (Math.atan2(q.y - p.y, q.x - p.x) * 180) / Math.PI,
      length: Math.hypot(q.x - p.x, q.y - p.y),
    };
  });

  // Loupe sits above the dragged corner, or below it when near the top
  const activePoint = activeCorner !== null ? screenCorners[activeCorner] : null;
  const LOUPE = 96;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black select-none touch-none overflow-hidden">
      {/* Top Header */}
      <div className="relative z-20 flex items-center justify-between px-4 pb-3 pt-safe-offset-3 bg-black/80 backdrop-blur-md border-b border-gray-800">
        <button
          onClick={onCancel}
          className="text-gray-300 hover:text-white px-3 py-1.5 rounded-lg text-sm font-medium"
        >
          Cancel
        </button>
        <span className="text-white text-sm font-semibold tracking-wide">
          Adjust Corners
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleAutoDetect}
            disabled={isDetecting}
            className="text-emerald-400 hover:text-emerald-300 px-2.5 py-1 rounded-lg text-xs font-semibold border border-emerald-500/40 active:scale-95 transition-all disabled:opacity-50"
          >
            {isDetecting ? 'Detecting...' : 'Auto Detect'}
          </button>
          <button
            onClick={handleResetFull}
            className="text-blue-400 hover:text-blue-300 px-2.5 py-1 rounded-lg text-xs font-medium active:scale-95 transition-all"
          >
            Select All
          </button>
        </div>
      </div>

      {/* Main View Area */}
      <div
        ref={containerRef}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="relative flex-1 overflow-hidden"
      >
        {imageUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={imageUrl}
            alt="Crop candidate"
            onLoad={onImageLoad}
            style={
              bounds.width > 0
                ? { left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height }
                : { visibility: 'hidden' }
            }
            className="absolute pointer-events-none"
          />
        )}

        {/* SVG Polygon & Lines Overlay */}
        {bounds.width > 0 && (
          <svg className="absolute inset-0 h-full w-full pointer-events-none z-10">
            <defs>
              <mask id="crop-mask">
                <rect width="100%" height="100%" fill="white" />
                <polygon points={svgPolygonPoints} fill="black" />
              </mask>
            </defs>
            <rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.55)" mask="url(#crop-mask)" />

            <polygon
              points={svgPolygonPoints}
              fill="rgba(59, 130, 246, 0.15)"
              stroke="#3b82f6"
              strokeWidth="2.5"
              strokeDasharray="6 4"
            />

            <line
              x1={(screenCorners[0].x * 2 + screenCorners[1].x) / 3}
              y1={(screenCorners[0].y * 2 + screenCorners[1].y) / 3}
              x2={(screenCorners[3].x * 2 + screenCorners[2].x) / 3}
              y2={(screenCorners[3].y * 2 + screenCorners[2].y) / 3}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth="1"
            />
            <line
              x1={(screenCorners[0].x + screenCorners[1].x * 2) / 3}
              y1={(screenCorners[0].y + screenCorners[1].y * 2) / 3}
              x2={(screenCorners[3].x + screenCorners[2].x * 2) / 3}
              y2={(screenCorners[3].y + screenCorners[2].y * 2) / 3}
              stroke="rgba(255,255,255,0.25)"
              strokeWidth="1"
            />
          </svg>
        )}

        {/* 4 Edge Drag Handles (hidden when the edge is too short to fit one) */}
        {bounds.width > 0 &&
          edgeHandles.map((h, idx) =>
            h.length < 96 ? null : (
              <div
                key={`edge-${idx}`}
                onPointerDown={(e) => handlePointerDown('edge', idx, e)}
                style={{
                  transform: `translate3d(${h.x - 22}px, ${h.y - 22}px, 0) rotate(${h.angle}deg)`,
                }}
                className="absolute left-0 top-0 z-20 flex h-11 w-11 items-center justify-center cursor-move"
                aria-label={`Drag ${edgeNames[idx]} edge`}
              >
                <div
                  className={`h-2 w-8 rounded-full border border-white shadow-lg transition-transform ${
                    drag?.kind === 'edge' && drag.index === idx
                      ? 'scale-125 bg-blue-500 ring-4 ring-blue-500/40'
                      : 'bg-blue-600'
                  }`}
                />
              </div>
            )
          )}

        {/* 4 Corner Drag Handles */}
        {bounds.width > 0 &&
          screenCorners.map((p, idx) => (
            <div
              key={idx}
              onPointerDown={(e) => handlePointerDown('corner', idx, e)}
              style={{
                transform: `translate3d(${p.x - 24}px, ${p.y - 24}px, 0)`,
              }}
              className="absolute left-0 top-0 z-20 flex h-12 w-12 items-center justify-center cursor-move"
              aria-label={`Drag ${cornerNames[idx]} corner`}
            >
              <div
                className={`h-6 w-6 rounded-full border-2 border-white shadow-lg transition-transform ${
                  activeCorner === idx
                    ? 'scale-125 bg-blue-500 ring-4 ring-blue-500/40'
                    : 'bg-blue-600 hover:scale-110'
                }`}
              >
                <div className="h-full w-full rounded-full flex items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-white"></div>
                </div>
              </div>
            </div>
          ))}

        {/* Magnifier Loupe Bubble */}
        {activeCorner !== null && activePoint && imageUrl && (
          <div
            style={{
              left: Math.max(12, Math.min(activePoint.x - LOUPE / 2, containerSize.width - LOUPE - 12)),
              top:
                activePoint.y - LOUPE - 40 >= 12
                  ? activePoint.y - LOUPE - 40
                  : activePoint.y + 40,
            }}
            className="absolute z-30 pointer-events-none h-24 w-24 rounded-full border-2 border-white bg-black shadow-2xl overflow-hidden ring-4 ring-blue-500/50"
          >
            <div
              style={{
                position: 'absolute',
                width: bounds.width * 2.2,
                height: bounds.height * 2.2,
                left: -corners[activeCorner].x * bounds.width * 2.2 + LOUPE / 2,
                top: -corners[activeCorner].y * bounds.height * 2.2 + LOUPE / 2,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageUrl}
                alt="Magnified loupe"
                className="w-full h-full object-contain pointer-events-none"
              />
            </div>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="h-4 w-[1px] bg-red-500"></div>
              <div className="w-4 h-[1px] bg-red-500 absolute"></div>
            </div>
          </div>
        )}
      </div>

      {/* Bottom Action Bar */}
      <div className="relative z-20 flex items-center justify-between gap-4 px-6 pt-4 pb-safe-offset-4 bg-black/90 border-t border-gray-800">
        <button
          onClick={onCancel}
          disabled={isProcessing}
          className="flex-1 rounded-xl bg-gray-800 py-3.5 text-sm font-semibold text-white hover:bg-gray-700 active:scale-98 transition-all"
        >
          Retake
        </button>
        <button
          onClick={handleApply}
          disabled={isProcessing}
          className="flex-1 rounded-xl bg-blue-600 py-3.5 text-sm font-semibold text-white shadow-lg hover:bg-blue-500 active:scale-98 transition-all flex items-center justify-center gap-2"
        >
          {isProcessing ? (
            <>
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent"></div>
              <span>Processing...</span>
            </>
          ) : (
            <span>Apply Crop ✓</span>
          )}
        </button>
      </div>
    </div>
  );
}
