import { db } from '@/lib/db';
import type { Annotation, Page } from '@/types';
import { requirePageImage } from '@/lib/page-image';
import { drawAnnotations, type SignatureImages } from './render';

export async function loadSignatureImages(annotations: Annotation[]): Promise<SignatureImages> {
  const ids = [...new Set(annotations.flatMap((a) => (a.type === 'signature' ? [a.signatureId] : [])))];
  const images: SignatureImages = new Map();
  await Promise.all(
    ids.map(async (id) => {
      const sig = await db.signatures.get(id);
      if (sig) images.set(id, await createImageBitmap(sig.blob));
    })
  );
  return images;
}

export async function getImageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const size = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return size;
}

/** The page image with its annotations burned in, at the original resolution. */
export async function getRenderedBlob(page: Page): Promise<Blob> {
  const base = requirePageImage(page);
  if (!page.annotations || page.annotations.length === 0) return base;

  const [bitmap, signatures] = await Promise.all([
    createImageBitmap(base),
    loadSignatureImages(page.annotations),
  ]);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  drawAnnotations(ctx, page.annotations, canvas.width, canvas.height, signatures);

  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to render annotations'))),
      'image/jpeg',
      0.92
    )
  );
}
