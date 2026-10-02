'use client';

import React, { useRef, useState, useEffect } from 'react';
import { useCamera } from '@/hooks/useCamera';

interface CameraViewProps {
  onCapture: (blob: Blob) => void;
  onClose: () => void;
}

export function CameraView({ onCapture, onClose }: CameraViewProps) {
  const { videoRef, isActive, isSupported, error, start, stop, capture } = useCamera();
  const [flash, setFlash] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    start();
    return () => {
      stop();
    };
  }, [start, stop]);

  const handleCapture = async () => {
    setFlash(true);
    setTimeout(() => setFlash(false), 200);
    const blob = await capture();
    if (blob) {
      onCapture(blob);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onCapture(file);
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
    <div className="fixed inset-0 bg-black z-50 flex flex-col">
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 p-4 flex justify-between items-center z-10 bg-gradient-to-b from-black/50 to-transparent">
        <button
          onClick={onClose}
          className="w-12 h-12 flex items-center justify-center rounded-full bg-black/40 text-white backdrop-blur-sm active:bg-black/60 transition-colors"
          aria-label="Close camera"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>

      {/* Viewfinder */}
      <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
        {flash && (
          <div className="absolute inset-0 bg-white z-20 opacity-80 transition-opacity duration-200"></div>
        )}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`w-full h-full object-cover ${!isActive ? 'opacity-0' : 'opacity-100'} transition-opacity duration-300`}
        />
        {!isActive && (
          <div className="absolute inset-0 flex items-center justify-center text-white">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="absolute bottom-0 left-0 right-0 pb-12 pt-8 flex justify-center items-center z-10 bg-gradient-to-t from-black/80 to-transparent">
        <button
          onClick={handleCapture}
          disabled={!isActive}
          className="w-20 h-20 rounded-full border-4 border-white flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50"
          aria-label="Take photo"
        >
          <div className="w-16 h-16 rounded-full bg-white"></div>
        </button>
      </div>
    </div>
  );
}
