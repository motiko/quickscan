'use client';

import { useEffect, useRef, useState } from 'react';
import { getImage } from '@/lib/images';

/**
 * Object URL of a stored image (lib/images.ts). Keyed by the image id, which only changes when
 * the image does: re-reading the record that points to it (every OCR status change does) keeps
 * the same URL, where a Blob read again would be a new object and a new URL. The previous URL
 * stays until the next one is ready, so a changed image doesn't flash empty.
 */
export function useImageUrl(id: string | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const show = (next: string | null) => {
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = next;
      setUrl(next);
    };
    getImage(id)
      .then((blob) => {
        if (!cancelled) show(blob ? URL.createObjectURL(blob) : null);
      })
      .catch((err) => {
        console.warn('Could not read an image:', err);
        if (!cancelled) show(null);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
      current.current = null;
    },
    []
  );

  return url;
}
