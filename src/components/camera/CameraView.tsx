'use client';

import React, { useRef, useState, useEffect, useCallback } from 'react';
import { useCamera } from '@/hooks/useCamera';
import { useScannerWorker } from '@/hooks/useScannerWorker';
import type { Quad } from '@/types';

interface CameraViewProps {
  onCapture: (blob: Blob, detectedCorners?: Quad | null) => void;
  onClose: () => void;
}

export function CameraView({ onCapture, onClose }: CameraViewProps) {
  const {
    videoRef,
    isActive,
    isSupported,
    error,
    hasTorch,
    isTorchOn,
    toggleTorch,
    start,
    stop,
    capture,
  } = useCamera();

  const { detect } = useScannerWorker();

  const [mode, setMode] = useState<'auto' | 'manual'>('auto');
  const [flash, setFlash] = useState(false);
  const [detectedCorners, setDetectedCorners] = useState<Quad | null>(null);
  const [isStable, setIsStable] = useState(false);
  const [autoProgress, setAutoProgress] = useState(0); // 0 to 100%

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDetectingRef = useRef(false);
  const prevCornersRef = useRef<Quad | null>(null);
  const prevSmoothedRef = useRef<Quad | null>(null);
  const stableCountRef = useRef(0);
  const isCapturingRef = useRef(false);

  useEffect(() => {
    start();
    return () => {
      stop();
    };
  }, [start, stop]);

  // Handle shutter capture
  const handleCapture = useCallback(
    async (cornersOverride?: Quad | null) => {
      if (isCapturingRef.current) return;
      isCapturingRef.current = true;

      setFlash(true);
      setTimeout(() => setFlash(false), 200);

      // Trigger haptic if available
      if (typeof window !== 'undefined' && 'vibrate' in navigator) {
        try {
          navigator.vibrate(50);
        } catch {
          // ignore
        }
      }

      try {
        const blob = await capture();
        const cornersToPass = cornersOverride !== undefined ? cornersOverride : detectedCorners;
        onCapture(blob, cornersToPass);
      } catch (err) {
        console.error('Capture failed:', err);
        isCapturingRef.current = false;
      }
    },
    [capture, detectedCorners, onCapture]
  );

  // Real-time edge detection loop
  useEffect(() => {
    if (!isActive || !videoRef.current) return;

    let animId: number;
    let lastCheckTime = 0;
    const offscreenCanvas = document.createElement('canvas');
    const offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });

    const checkFrame = async (timestamp: number) => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || isCapturingRef.current) {
        animId = requestAnimationFrame(checkFrame);
        return;
      }

      // Run detection every 120ms (~8 FPS) for optimal battery and responsive tracking
      if (timestamp - lastCheckTime > 120 && !isDetectingRef.current && offscreenCtx) {
        lastCheckTime = timestamp;
        isDetectingRef.current = true;

        try {
          // Downscale to 320px width for fast Sobel gradient / RDP
          const targetW = 320;
          const targetH = Math.round((video.videoHeight / (video.videoWidth || 1)) * targetW) || 240;

          offscreenCanvas.width = targetW;
          offscreenCanvas.height = targetH;
          offscreenCtx.drawImage(video, 0, 0, targetW, targetH);

          const imageData = offscreenCtx.getImageData(0, 0, targetW, targetH);
          const result = await detect(imageData);

          if (result.normalizedCorners && result.confidence > 0.3) {
            // Use the pre-smoothed corners from the worker
            setDetectedCorners(result.normalizedCorners);
            setIsStable(result.isStable ?? false);
            setAutoProgress(Math.round((result.stability ?? 0) * 100));

            if (result.isStable && mode === 'auto' && !isCapturingRef.current) {
              // Auto capture trigger driven by the worker's stability logic
              handleCapture(result.normalizedCorners);
            }
          } else {
            setDetectedCorners(null);
            setIsStable(false);
            setAutoProgress(0);
          }
        } catch (err) {
          console.warn('Frame detection error:', err);
        } finally {
          isDetectingRef.current = false;
        }
      }

      animId = requestAnimationFrame(checkFrame);
    };

    animId = requestAnimationFrame(checkFrame);

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [isActive, videoRef, detect, mode, handleCapture]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onCapture(file, null);
    }
  };

  if (!isSupported || error) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center p-4 z-50">
        <div className="text-white text-center mb-6">
          <p className="text-xl font-semibold mb-2">Camera Unavailable</p>
          <p className="text-gray-400">{error || 'Your device does not support camera access.'}</p>
        </div>
        <input
          type="file"
          accept="image/*"
          capture="environment"
          ref={fileInputRef}
          onChange={handleFileChange}
          className="hidden"
        />
        <div className="flex flex-col gap-4 w-full max-w-xs">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="w-full bg-blue-600 text-white py-3 px-6 rounded-full font-semibold hover:bg-blue-700 active:bg-blue-800 transition-colors"
          >
            Choose from Photo Library
          </button>
          {error && (
            <button
              onClick={() => start()}
              className="w-full bg-gray-800 text-white py-3 px-6 rounded-full font-semibold hover:bg-gray-700 active:bg-gray-600 transition-colors"
            >
              Retry Camera
            </button>
          )}
          <button
            onClick={onClose}
            className="w-full bg-transparent border border-gray-600 text-white py-3 px-6 rounded-full font-semibold hover:bg-gray-800 active:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }


  return (
    <div className="fixed inset-0 bg-black z-50 flex flex-col select-none touch-none overflow-hidden">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 px-4 pb-4 pt-safe-offset-4 flex justify-between items-center z-30 bg-gradient-to-b from-black/90 via-black/50 to-transparent">
        <button
          onClick={onClose}
          className="w-11 h-11 flex items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-md active:bg-black/70 transition-colors"
          aria-label="Close camera"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>

        {/* Auto / Manual Mode Toggle */}
        <div className="flex items-center bg-black/60 backdrop-blur-md rounded-full p-1 border border-white/20">
          <button
            onClick={() => setMode('auto')}
            className={`px-3.5 py-1 rounded-full text-xs font-semibold transition-all ${
              mode === 'auto'
                ? 'bg-blue-600 text-white shadow'
                : 'text-gray-300 hover:text-white'
            }`}
          >
            Auto
          </button>
          <button
            onClick={() => setMode('manual')}
            className={`px-3.5 py-1 rounded-full text-xs font-semibold transition-all ${
              mode === 'manual'
                ? 'bg-blue-600 text-white shadow'
                : 'text-gray-300 hover:text-white'
            }`}
          >
            Manual
          </button>
        </div>

        {/* Flash / Torch Toggle */}
        {hasTorch ? (
          <button
            onClick={toggleTorch}
            className={`w-11 h-11 flex items-center justify-center rounded-full backdrop-blur-md transition-colors ${
              isTorchOn ? 'bg-yellow-400 text-black' : 'bg-black/50 text-white'
            }`}
            aria-label="Toggle flashlight"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill={isTorchOn ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
            </svg>
          </button>
        ) : (
          <div className="w-11 h-11" />
        )}
      </div>

      {/* Viewfinder */}
      <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
        {flash && (
          <div className="absolute inset-0 bg-white z-40 opacity-80 transition-opacity duration-200"></div>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${!isActive ? 'opacity-0' : 'opacity-100'} transition-opacity duration-300`}
        />

        {/* Live SVG Quad Polygon Overlay */}
        {detectedCorners && isActive && (
          <svg
            viewBox="0 0 1000 1000"
            preserveAspectRatio="none"
            className="absolute inset-0 h-full w-full pointer-events-none z-20"
          >
            {/* Detected polygon shape */}
            <polygon
              points={detectedCorners
                .map((p) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`)
                .join(' ')}
              fill={isStable ? 'rgba(34, 197, 94, 0.25)' : 'rgba(59, 130, 246, 0.18)'}
              stroke={isStable ? '#22c55e' : '#3b82f6'}
              strokeWidth="6"
              strokeDasharray={isStable ? undefined : '12 8'}
              className="transition-colors duration-200"
            />
            {/* 4 Corner Pin Markers */}
            {detectedCorners.map((p, idx) => (
              <circle
                key={idx}
                cx={p.x * 1000}
                cy={p.y * 1000}
                r="16"
                fill={isStable ? '#22c55e' : '#60a5fa'}
                stroke="#ffffff"
                strokeWidth="5"
              />
            ))}
          </svg>
        )}

        {/* Scanning Guidance Badge */}
        <div className="absolute top-[calc(env(safe-area-inset-top,0px)+5rem)] left-0 right-0 z-20 flex justify-center pointer-events-none">
          {detectedCorners ? (
            <span
              className={`rounded-full px-4 py-1.5 text-xs font-semibold backdrop-blur-md shadow transition-all ${
                isStable
                  ? 'bg-emerald-600/90 text-white ring-2 ring-emerald-400'
                  : 'bg-black/60 text-blue-300 border border-blue-500/30'
              }`}
            >
              {isStable
                ? mode === 'auto'
                  ? 'Hold steady... Capturing!'
                  : 'Ready to capture!'
                : 'Document detected — hold steady'}
            </span>
          ) : (
            <span className="rounded-full bg-black/50 px-4 py-1.5 text-xs font-medium text-gray-300 backdrop-blur-md border border-white/10">
              Align document inside frame
            </span>
          )}
        </div>

        {!isActive && (
          <div className="absolute inset-0 flex items-center justify-center text-white">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 pt-8 pb-safe-offset-6 flex justify-center items-center z-30 bg-gradient-to-t from-black/90 via-black/50 to-transparent">
        {/* Shutter Button with Auto-Capture Radial Progress */}
        <div className="relative flex items-center justify-center">
          {mode === 'auto' && autoProgress > 0 && (
            <svg className="absolute w-24 h-24 -rotate-90 pointer-events-none">
              <circle
                cx="48"
                cy="48"
                r="44"
                stroke="rgba(255,255,255,0.2)"
                strokeWidth="4"
                fill="none"
              />
              <circle
                cx="48"
                cy="48"
                r="44"
                stroke="#22c55e"
                strokeWidth="4"
                strokeDasharray={276.46}
                strokeDashoffset={276.46 - (276.46 * autoProgress) / 100}
                strokeLinecap="round"
                fill="none"
                className="transition-all duration-100 ease-linear"
              />
            </svg>
          )}

          <button
            onClick={() => handleCapture()}
            disabled={!isActive}
            className={`w-20 h-20 rounded-full border-4 flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50 ${
              isStable ? 'border-emerald-400 ring-4 ring-emerald-400/30' : 'border-white'
            }`}
            aria-label="Take photo"
          >
            <div
              className={`w-16 h-16 rounded-full transition-colors ${
                isStable ? 'bg-emerald-400' : 'bg-white'
              }`}
            ></div>
          </button>
        </div>
      </div>
    </div>
  );
}
