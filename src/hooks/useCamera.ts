'use client';

import { useRef, useState, useCallback, useEffect } from 'react';
import { startCamera, stopCamera, captureFrame, isCameraSupported } from '@/lib/camera';

interface UseCameraOptions {
  facingMode?: 'user' | 'environment';
}

interface UseCameraReturn {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isActive: boolean;
  isSupported: boolean;
  error: string | null;
  hasTorch: boolean;
  isTorchOn: boolean;
  toggleTorch: () => Promise<void>;
  start: () => Promise<void>;
  stop: () => void;
  capture: (quality?: number) => Promise<Blob>;
}

export function useCamera(options: UseCameraOptions = {}): UseCameraReturn {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasTorch, setHasTorch] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const isSupported = isCameraSupported();

  const start = useCallback(async () => {
    if (!videoRef.current) return;
    setError(null);
    try {
      const stream = await startCamera(videoRef.current, {
        facingMode: options.facingMode || 'environment',
      });
      streamRef.current = stream;
      setIsActive(true);

      const track = stream.getVideoTracks()[0];
      if (track) {
        // Feature detect torch capability
        const capabilities = (track as unknown as { getCapabilities?: () => { torch?: boolean } }).getCapabilities?.();
        if (capabilities?.torch) {
          setHasTorch(true);
        }
      }
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === 'NotAllowedError'
          ? 'Camera access denied. Please allow camera access in your browser settings.'
          : err instanceof DOMException && err.name === 'NotFoundError'
            ? 'No camera found on this device.'
            : 'Failed to start camera. Please try again.';
      setError(message);
      setIsActive(false);
    }
  }, [options.facingMode]);

  const stop = useCallback(() => {
    stopCamera(streamRef.current);
    streamRef.current = null;
    setIsActive(false);
    setIsTorchOn(false);
  }, []);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (track && 'applyConstraints' in track) {
      try {
        const nextState = !isTorchOn;
        await (track as unknown as { applyConstraints: (c: unknown) => Promise<void> }).applyConstraints({
          advanced: [{ torch: nextState }],
        });
        setIsTorchOn(nextState);
      } catch (err) {
        console.warn('Torch failed:', err);
      }
    }
  }, [isTorchOn]);

  const capture = useCallback(
    async (quality = 0.92): Promise<Blob> => {
      if (!videoRef.current || !isActive) {
        throw new Error('Camera is not active');
      }
      return captureFrame(videoRef.current, quality);
    },
    [isActive]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopCamera(streamRef.current);
    };
  }, []);

  return {
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
  };
}
