'use client';

import { useEffect, useState } from 'react';
import type { Page } from '@/types';
import { getRenderedBlob } from '@/lib/annotations/flatten';
import { useBlobUrl } from '@/hooks/useBlobUrl';
import { useImageUrl } from '@/hooks/useImageUrl';
import { pageImageId } from '@/lib/page-image';

/** Object URL of the page image with annotations composited on top. */
export function useRenderedPageUrl(page: Page | null): string | null {
  const imageId = page ? pageImageId(page) : undefined;
  const annotations = page?.annotations;
  // Every read of the page is a new array: compare the content
  const annotationsKey = annotations?.length ? JSON.stringify(annotations) : '';
  const plainUrl = useImageUrl(imageId);
  const [rendered, setRendered] = useState<{ key: string; blob: Blob } | null>(null);

  useEffect(() => {
    if (!page || !imageId || !annotationsKey) return;
    let cancelled = false;
    getRenderedBlob(page)
      .then((blob) => {
        if (!cancelled) setRendered({ key: `${imageId}|${annotationsKey}`, blob });
      })
      .catch((err) => console.warn('Failed to render annotations:', err));
    return () => {
      cancelled = true;
    };
    // Re-render only when the image or the annotations change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, annotationsKey]);

  const composite = annotationsKey && rendered?.key === `${imageId}|${annotationsKey}` ? rendered.blob : null;
  const compositeUrl = useBlobUrl(composite);
  // Until the composite is ready, show the plain image rather than nothing
  return composite && compositeUrl ? compositeUrl : plainUrl;
}
