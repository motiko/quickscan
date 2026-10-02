'use client';

import { useEffect, useState } from 'react';
import type { Page } from '@/types';
import { getRenderedBlob } from '@/lib/annotations/flatten';
import { useBlobUrl } from '@/hooks/useBlobUrl';

/** Object URL of the page image with annotations composited on top. */
export function useRenderedPageUrl(page: Page | null): string | null {
  const base = page ? page.processedBlob || page.originalBlob : null;
  const annotations = page?.annotations;
  const [rendered, setRendered] = useState<{ source: Page['annotations']; blob: Blob } | null>(null);

  useEffect(() => {
    if (!page || !annotations?.length) return;
    let cancelled = false;
    getRenderedBlob(page)
      .then((blob) => {
        if (!cancelled) setRendered({ source: annotations, blob });
      })
      .catch((err) => console.warn('Failed to render annotations:', err));
    return () => {
      cancelled = true;
    };
    // Re-render only when the image or the annotations change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, annotations]);

  const hasAnnotations = !!annotations?.length;
  // Until the composite is ready, show the plain image rather than nothing
  const blob = hasAnnotations && rendered?.source === annotations ? rendered.blob : base;
  return useBlobUrl(blob);
}
