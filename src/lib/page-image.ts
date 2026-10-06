import type { Page } from '@/types';
import { getImage } from '@/lib/images';

/*
 * A page's image is its processed image, falling back to the original capture. A page pulled
 * from another device has no original (originals never sync), and no image at all until its
 * processed image has downloaded; callers that need pixels must handle that. Both are rows of
 * `images` (lib/images.ts); the page holds their ids.
 */

type PageImageIds = Pick<Page, 'processedImageId' | 'originalImageId'>;

export class PageImageMissingError extends Error {
  constructor() {
    super('This page’s image hasn’t downloaded yet');
    this.name = 'PageImageMissingError';
  }
}

/** Id of the image the page shows. A new image always gets a new id. */
export function pageImageId(page: PageImageIds): string | undefined {
  return page.processedImageId || page.originalImageId;
}

export function hasPageImage(page: PageImageIds): boolean {
  return pageImageId(page) !== undefined;
}

export function pageImage(page: PageImageIds): Promise<Blob | undefined> {
  return getImage(pageImageId(page));
}

export async function requirePageImage(page: PageImageIds): Promise<Blob> {
  const blob = await pageImage(page);
  if (!blob) throw new PageImageMissingError();
  return blob;
}
