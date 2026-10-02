'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { Point, Quad } from '@/types';
import { warpPerspective } from '@/lib/image-processing';
import { useBlobUrl } from '@/hooks/useBlobUrl';

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

  const [activeCorner, setActiveCorner] = useState<number | null>(null);
  const [touchPos, setTouchPos] = useState<Point | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  // Compute displayed image bounding box inside container from state
  const bounds = useMemo(() => {
    if (containerSize.width === 0 || naturalSize.width === 0) {
      return { x: 0, y: 0, width: 0, height: 0 };
    }
    const aspect = naturalSize.width / naturalSize.height;
    const containerAspect = containerSize.width / containerSize.height;

    let width = 0;
    let height = 0;
    let x = 0;
    let y = 0;

    if (containerAspect > aspect) {
      height = containerSize.height;
      width = height * aspect;
      x = (containerSize.width - width) / 2;
      y = 0;
    } else {
      width = containerSize.width;
      height = width / aspect;
      x = 0;
      y = (containerSize.height - height) / 2;
    }

    return { x, y, width, height };
  }, [containerSize, naturalSize]);

  // Load natural dimensions
  const onImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ width: img.naturalWidth, height: img.naturalHeight });
  };

  // Convert client coordinates to normalized coordinates [0..1]
  const clientToNormalized = useCallback(
    (clientX: number, clientY: number): Point => {
      if (!containerRef.current || bounds.width === 0 || bounds.height === 0) {
        return { x: 0, y: 0 };
      }
      const containerRect = containerRef.current.getBoundingClientRect();

      const relX = clientX - containerRect.left - bounds.x;
      const relY = clientY - containerRect.top - bounds.y;

      const normX = Math.max(0, Math.min(1, relX / bounds.width));
      const normY = Math.max(0, Math.min(1, relY / bounds.height));

      return { x: normX, y: normY };
    },
    [bounds]
  );

  // Pointer drag events
  const handlePointerDown = (index: number, e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setActiveCorner(index);
    if (containerRef.current) {
      const containerRect = containerRef.current.getBoundingClientRect();
      setTouchPos({
        x: e.clientX - containerRect.left,
        y: e.clientY - containerRect.top,
      });
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (activeCorner === null || !containerRef.current) return;
    e.preventDefault();

    const containerRect = containerRef.current.getBoundingClientRect();
    setTouchPos({
      x: e.clientX - containerRect.left,
      y: e.clientY - containerRect.top,
    });

    const norm = clientToNormalized(e.clientX, e.clientY);
    setCorners((prev) => {
      const next = [...prev] as Quad;
      next[activeCorner] = norm;
      return next;
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (activeCorner !== null) {
      try {
        (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      setActiveCorner(null);
      setTouchPos(null);
    }
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
      alert('Could not apply crop. Please try adjusting the corners.');
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

  return (
    <div
      ref={containerRef}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      className="fixed inset-0 z-50 flex flex-col bg-black select-none touch-none overflow-hidden"
    >
      {/* Top Header */}
      <div className="relative z-20 flex items-center justify-between px-4 pb-3 pt-safe-offset-3 bg-black/80 backdrop-blur-md border-b border-gray-800">
        <button
          onClick={onCancel}
          className="text-gray-300 hover:text-white px-3 py-1.5 rounded-lg text-sm font-medium"
        >
          Cancel
        </button>
        <span className="text-white text-sm font-semibold tracking-wide">
          Adjust Document Corners
        </span>
        <button
          onClick={handleResetFull}
          className="text-blue-400 hover:text-blue-300 px-3 py-1.5 rounded-lg text-sm font-medium"
        >
          Select All
        </button>
      </div>

      {/* Main View Area */}
      <div className="relative flex-1 flex items-center justify-center overflow-hidden">
        {imageUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={imageUrl}
            alt="Crop candidate"
            onLoad={onImageLoad}
            className="max-h-full max-w-full object-contain pointer-events-none"
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

        {/* 4 Interactive Drag Handles */}
        {bounds.width > 0 &&
          screenCorners.map((p, idx) => (
            <div
              key={idx}
              onPointerDown={(e) => handlePointerDown(idx, e)}
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
        {activeCorner !== null && touchPos && imageUrl && (
          <div
            style={{
              left: Math.max(12, Math.min(touchPos.x - 48, containerSize.width - 108)),
              top: Math.max(12, touchPos.y - 120),
            }}
            className="absolute z-30 pointer-events-none h-24 w-24 rounded-full border-2 border-white bg-black shadow-2xl overflow-hidden ring-4 ring-blue-500/50"
          >
            <div
              style={{
                position: 'absolute',
                width: bounds.width * 2.2,
                height: bounds.height * 2.2,
                left: -(bounds.x + corners[activeCorner].x * bounds.width) * 2.2 + 48,
                top: -(bounds.y + corners[activeCorner].y * bounds.height) * 2.2 + 48,
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
