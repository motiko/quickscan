/** Page images shrunk to what vision models actually use, as base64 JPEG. */

export interface LlmImage {
  mediaType: 'image/jpeg';
  data: string;
}

/** Dimensions scaled down (never up) so the longer edge is at most `maxEdge`. */
export function fitWithin(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function renderJpeg(bitmap: ImageBitmap, width: number, height: number, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, width, height);
      return canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');
  ctx.drawImage(bitmap, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode image'))), 'image/jpeg', quality)
  );
}

/** Downscale an image so its longer edge is at most `maxEdge` and encode it as base64 JPEG. */
export async function prepareImageForLlm(blob: Blob, maxEdge = 1568, quality = 0.85): Promise<LlmImage> {
  const bitmap = await createImageBitmap(blob);
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, maxEdge);
    const jpeg = await renderJpeg(bitmap, width, height, quality);
    return { mediaType: 'image/jpeg', data: bytesToBase64(new Uint8Array(await jpeg.arrayBuffer())) };
  } finally {
    bitmap.close();
  }
}
