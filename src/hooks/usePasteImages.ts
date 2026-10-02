'use client';

import { useEffect, useRef } from 'react';
import { imagesFromClipboard } from '@/lib/import';

/** Call `onImages` with the images pasted anywhere on the page (Cmd/Ctrl+V). Text pastes are left alone. */
export function usePasteImages(onImages: (files: File[]) => void, enabled = true): void {
  const callback = useRef(onImages);
  useEffect(() => {
    callback.current = onImages;
  });

  useEffect(() => {
    if (!enabled) return;
    const handlePaste = (e: ClipboardEvent) => {
      const files = imagesFromClipboard(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      callback.current(files);
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [enabled]);
}
