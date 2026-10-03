import type { Page } from '@/types';

/*
 * A page's image is its processed image, falling back to the original capture. A page pulled
 * from another device has no original (originals never sync), and no image at all until its
 * processed image has downloaded; callers that need pixels must handle that.
 */

export class PageImageMissingError extends Error {
  constructor() {
    super('This page’s image hasn’t downloaded yet');
    this.name = 'PageImageMissingError';
  }
}

export function pageImage(page: Pick<Page, 'processedBlob' | 'originalBlob'>): Blob | undefined {
  return page.processedBlob || page.originalBlob;
}

export function hasPageImage(page: Pick<Page, 'processedBlob' | 'originalBlob'>): boolean {
  return pageImage(page) !== undefined;
}

export function requirePageImage(page: Pick<Page, 'processedBlob' | 'originalBlob'>): Blob {
  const blob = pageImage(page);
  if (!blob) throw new PageImageMissingError();
  return blob;
}
