'use client';

import { useState, useEffect } from 'react';

export function useBlobUrl(blob: Blob | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob) {
      const timer = setTimeout(() => setUrl(null), 0);
      return () => clearTimeout(timer);
    }

    const objectUrl = URL.createObjectURL(blob);
    const timer = setTimeout(() => {
      setUrl(objectUrl);
    }, 0);

    return () => {
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
    };
  }, [blob]);

  return url;
}
