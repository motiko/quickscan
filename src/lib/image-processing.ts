import type { ImageFilter, Quad } from '@/types';

/**
 * Calculates the bounding width and height from four corner points.
 */
export function getQuadDimensions(corners: Quad): { width: number; height: number } {
  const [tl, tr, br, bl] = corners;

  const topWidth = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomWidth = Math.hypot(br.x - bl.x, br.y - bl.y);
  const width = Math.max(10, Math.round(Math.max(topWidth, bottomWidth)));

  const leftHeight = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightHeight = Math.hypot(br.x - tr.x, br.y - tr.y);
  const height = Math.max(10, Math.round(Math.max(leftHeight, rightHeight)));

  return { width, height };
}

/**
 * Computes 3x3 projective transformation matrix from target rectangle [0, width] x [0, height]
 * to arbitrary source quadrilateral corners [tl, tr, br, bl].
 */
export function getInversePerspectiveMatrix(
  dstWidth: number,
  dstHeight: number,
  srcCorners: Quad
): number[] {
  const [tl, tr, br, bl] = srcCorners;

  const x0 = tl.x, y0 = tl.y;
  const x1 = tr.x, y1 = tr.y;
  const x2 = br.x, y2 = br.y;
  const x3 = bl.x, y3 = bl.y;

  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const dy3 = y0 - y1 + y2 - y3;

  let a11: number, a12: number, a13: number;
  let a21: number, a22: number, a23: number;
  let a31: number, a32: number;

  const det = dx1 * dy2 - dx2 * dy1;

  if (Math.abs(det) < 1e-7 || (Math.abs(dx3) < 1e-7 && Math.abs(dy3) < 1e-7)) {
    // Affine fallback
    a11 = x1 - x0;
    a12 = x2 - x1;
    a13 = x0;
    a21 = y1 - y0;
    a22 = y2 - y1;
    a23 = y0;
    a31 = 0;
    a32 = 0;
  } else {
    // Full Projective transform
    a31 = (dx3 * dy2 - dx2 * dy3) / det;
    a32 = (dx1 * dy3 - dx3 * dy1) / det;
    a11 = x1 - x0 + a31 * x1;
    a12 = x3 - x0 + a32 * x3;
    a13 = x0;
    a21 = y1 - y0 + a31 * y1;
    a22 = y3 - y0 + a32 * y3;
    a23 = y0;
  }

  // Scale from unit square to destination rectangle [dstWidth, dstHeight]
  return [
    a11 / dstWidth, a12 / dstHeight, a13,
    a21 / dstWidth, a22 / dstHeight, a23,
    a31 / dstWidth, a32 / dstHeight, 1.0,
  ];
}

/*
 * Memory: iOS Safari caps the pixel memory a page's canvases may hold, counting detached
 * canvases until they're garbage collected, and an object URL pins its blob until revoked. A
 * pipeline that leaves its full-size canvases and URLs to the collector runs a phone out of
 * memory, and iOS then kills the page ("This page couldn't load"). So every helper here decodes
 * through `loadImage` (URL revoked as soon as the image is decoded) and frees each canvas
 * through `canvasToBlob` / `releaseCanvas` the moment it's done with it.
 */

/** Decode `blob` into an image element; its object URL is revoked once decoded (or failed). */
export function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image'));
    };
    img.src = url;
  });
}

/** Free a canvas's pixel buffer now instead of whenever the element is collected. */
export function releaseCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

/** Encode a canvas, then free it. */
export function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        releaseCanvas(canvas);
        if (blob) resolve(blob);
        else reject(new Error('Failed to encode image'));
      },
      type,
      quality
    );
  });
}

/**
 * Warps a quadrilateral section of an image into a rectified flat rectangle.
 */
export async function warpPerspective(
  sourceBlob: Blob,
  corners: Quad,
  quality = 0.95
): Promise<Blob> {
  const img = await loadImage(sourceBlob);
  const { width: dstW, height: dstH } = getQuadDimensions(corners);
  const srcW = img.width;
  const srcH = img.height;

  // The source canvas only serves to read the pixels: freed before the output is allocated
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = srcW;
  srcCanvas.height = srcH;
  const srcCtx = srcCanvas.getContext('2d', { willReadFrequently: true });
  if (!srcCtx) throw new Error('Failed to get source 2D canvas context');
  srcCtx.drawImage(img, 0, 0);
  const srcData = srcCtx.getImageData(0, 0, srcW, srcH).data;
  releaseCanvas(srcCanvas);

  const dstCanvas = document.createElement('canvas');
  dstCanvas.width = dstW;
  dstCanvas.height = dstH;
  const dstCtx = dstCanvas.getContext('2d');
  if (!dstCtx) throw new Error('Failed to get destination 2D canvas context');

  const dstImageData = dstCtx.createImageData(dstW, dstH);
  const dstData = dstImageData.data;

  const H = getInversePerspectiveMatrix(dstW, dstH, corners);
  const [h00, h01, h02, h10, h11, h12, h20, h21, h22] = H;

  let dstIdx = 0;
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      const w = h20 * x + h21 * y + h22;
      const invW = w !== 0 ? 1 / w : 0;
      const sx = (h00 * x + h01 * y + h02) * invW;
      const sy = (h10 * x + h11 * y + h12) * invW;

      if (sx >= 0 && sx < srcW - 1 && sy >= 0 && sy < srcH - 1) {
        const x0 = Math.floor(sx);
        const x1 = x0 + 1;
        const y0 = Math.floor(sy);
        const y1 = y0 + 1;

        const fx = sx - x0;
        const fy = sy - y0;
        const w00 = (1 - fx) * (1 - fy);
        const w10 = fx * (1 - fy);
        const w01 = (1 - fx) * fy;
        const w11 = fx * fy;

        const idx00 = (y0 * srcW + x0) * 4;
        const idx10 = (y0 * srcW + x1) * 4;
        const idx01 = (y1 * srcW + x0) * 4;
        const idx11 = (y1 * srcW + x1) * 4;

        dstData[dstIdx] =
          w00 * srcData[idx00] +
          w10 * srcData[idx10] +
          w01 * srcData[idx01] +
          w11 * srcData[idx11];
        dstData[dstIdx + 1] =
          w00 * srcData[idx00 + 1] +
          w10 * srcData[idx10 + 1] +
          w01 * srcData[idx01 + 1] +
          w11 * srcData[idx11 + 1];
        dstData[dstIdx + 2] =
          w00 * srcData[idx00 + 2] +
          w10 * srcData[idx10 + 2] +
          w01 * srcData[idx01 + 2] +
          w11 * srcData[idx11 + 2];
        dstData[dstIdx + 3] = 255;
      } else if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        const nearestIdx = (Math.floor(sy) * srcW + Math.floor(sx)) * 4;
        dstData[dstIdx] = srcData[nearestIdx];
        dstData[dstIdx + 1] = srcData[nearestIdx + 1];
        dstData[dstIdx + 2] = srcData[nearestIdx + 2];
        dstData[dstIdx + 3] = 255;
      } else {
        dstData[dstIdx] = 255;
        dstData[dstIdx + 1] = 255;
        dstData[dstIdx + 2] = 255;
        dstData[dstIdx + 3] = 255;
      }
      dstIdx += 4;
    }
  }

  dstCtx.putImageData(dstImageData, 0, 0);
  return canvasToBlob(dstCanvas, 'image/jpeg', quality);
}

/**
 * Rotates an image clockwise by 90, 180, or 270 degrees.
 */
export async function rotateImage(
  sourceBlob: Blob,
  degrees: 90 | 180 | 270,
  quality = 0.95
): Promise<Blob> {
  const img = await loadImage(sourceBlob);
  const is90or270 = degrees === 90 || degrees === 270;
  const canvas = document.createElement('canvas');
  canvas.width = is90or270 ? img.height : img.width;
  canvas.height = is90or270 ? img.width : img.height;

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((degrees * Math.PI) / 180);
  ctx.drawImage(img, -img.width / 2, -img.height / 2);

  return canvasToBlob(canvas, sourceBlob.type === 'image/png' ? 'image/png' : 'image/jpeg', quality);
}

interface Background {
  values: Float32Array;
  cols: number;
  rows: number;
  blockSize: number;
}

const BACKGROUND_GRID = 160;
const BACKGROUND_DILATE_RADIUS = 2;
const BACKGROUND_BLUR_RADIUS = 2;

function toLuminance(data: Uint8ClampedArray, numPixels: number): Float32Array {
  const gray = new Float32Array(numPixels);
  for (let i = 0, j = 0; j < numPixels; i += 4, j++) {
    gray[j] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return gray;
}

function boxBlur(src: Float32Array, width: number, height: number, radius: number): Float32Array {
  if (radius < 1) return src;
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, x - radius); k <= Math.min(width - 1, x + radius); k++) {
        sum += src[row + k];
        count++;
      }
      tmp[row + x] = sum / count;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let k = Math.max(0, y - radius); k <= Math.min(height - 1, y + radius); k++) {
        sum += tmp[k * width + x];
        count++;
      }
      out[y * width + x] = sum / count;
    }
  }
  return out;
}

/**
 * Estimates the paper's illumination as a smooth low-resolution map: block means are dilated
 * (max filter) to erase dark ink, then blurred so shadows and lighting gradients stay seamless.
 */
export function estimateBackground(gray: Float32Array, width: number, height: number): Background {
  const blockSize = Math.max(1, Math.ceil(Math.max(width, height) / BACKGROUND_GRID));
  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);

  const means = new Float32Array(cols * rows);
  for (let by = 0; by < rows; by++) {
    const yEnd = Math.min(height, (by + 1) * blockSize);
    for (let bx = 0; bx < cols; bx++) {
      const xEnd = Math.min(width, (bx + 1) * blockSize);
      let sum = 0;
      let count = 0;
      for (let y = by * blockSize; y < yEnd; y++) {
        const row = y * width;
        for (let x = bx * blockSize; x < xEnd; x++) {
          sum += gray[row + x];
          count++;
        }
      }
      means[by * cols + bx] = sum / count;
    }
  }

  const dilated = new Float32Array(cols * rows);
  const r = BACKGROUND_DILATE_RADIUS;
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      let maxVal = 0;
      for (let y = Math.max(0, by - r); y <= Math.min(rows - 1, by + r); y++) {
        for (let x = Math.max(0, bx - r); x <= Math.min(cols - 1, bx + r); x++) {
          const v = means[y * cols + x];
          if (v > maxVal) maxVal = v;
        }
      }
      dilated[by * cols + bx] = maxVal;
    }
  }

  const values = boxBlur(boxBlur(dilated, cols, rows, BACKGROUND_BLUR_RADIUS), cols, rows, BACKGROUND_BLUR_RADIUS);

  // Large dark regions (photos, black boxes) are not paper; don't let them be brightened to white.
  const sorted = Float32Array.from(values).sort();
  const paperLevel = sorted[Math.floor(sorted.length * 0.95)];
  const floor = Math.max(40, paperLevel * 0.45);
  for (let i = 0; i < values.length; i++) {
    if (values[i] < floor) values[i] = floor;
  }

  return { values, cols, rows, blockSize };
}

/**
 * Divides every pixel's luminance by the bilinearly interpolated background, producing a map where
 * paper is ~255 regardless of shadows. Calls `visit(pixelIndex, normalizedGray, scale)` per pixel.
 */
function forEachNormalized(
  gray: Float32Array,
  width: number,
  height: number,
  bg: Background,
  visit: (i: number, normalized: number, scale: number) => void
): void {
  const { values, cols, rows, blockSize } = bg;
  const half = blockSize / 2;

  const x0s = new Int32Array(width);
  const x1s = new Int32Array(width);
  const fxs = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const gx = Math.min(cols - 1, Math.max(0, (x - half) / blockSize));
    x0s[x] = Math.floor(gx);
    x1s[x] = Math.min(cols - 1, x0s[x] + 1);
    fxs[x] = gx - x0s[x];
  }

  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.max(0, (y - half) / blockSize));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fy = gy - y0;
    const r0 = y0 * cols;
    const r1 = y1 * cols;
    const row = y * width;

    for (let x = 0; x < width; x++) {
      const fx = fxs[x];
      const top = values[r0 + x0s[x]] * (1 - fx) + values[r0 + x1s[x]] * fx;
      const bottom = values[r1 + x0s[x]] * (1 - fx) + values[r1 + x1s[x]] * fx;
      const scale = 255 / (top * (1 - fy) + bottom * fy);
      const i = row + x;
      visit(i, Math.min(255, gray[i] * scale), scale);
    }
  }
}

/**
 * Tone curve that clips near-white paper to pure white and deepens faint ink.
 */
function buildToneLut(blackPoint: number, whitePoint: number, gamma: number): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - blackPoint) / (whitePoint - blackPoint)));
    lut[v] = Math.round(255 * Math.pow(t, gamma));
  }
  return lut;
}

function otsuThreshold(values: Float32Array): number {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[values[i] | 0]++;

  let totalSum = 0;
  for (let v = 0; v < 256; v++) totalSum += v * hist[v];

  let bgCount = 0;
  let bgSum = 0;
  let bestVar = -1;
  let best = 128;
  for (let t = 0; t < 256; t++) {
    bgCount += hist[t];
    if (bgCount === 0) continue;
    const fgCount = values.length - bgCount;
    if (fgCount === 0) break;
    bgSum += t * hist[t];
    const meanBg = bgSum / bgCount;
    const meanFg = (totalSum - bgSum) / fgCount;
    const betweenVar = bgCount * fgCount * (meanBg - meanFg) ** 2;
    if (betweenVar > bestVar) {
      bestVar = betweenVar;
      best = t;
    }
  }
  return best;
}

const BW_MIN_THRESHOLD = 140;
const BW_MAX_THRESHOLD = 215;
const BW_SOFTNESS = 12;
const DESPECKLE_MIN_SIZE = 1000;

/**
 * Black & white document filter: flattens illumination, picks a global Otsu threshold on the
 * flattened image, and keeps a narrow grey ramp at stroke edges so text stays smooth, not jagged.
 */
export function applyBlackAndWhite(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const numPixels = width * height;
  const gray = toLuminance(data, numPixels);
  const bg = estimateBackground(gray, width, height);

  const normalized = new Float32Array(numPixels);
  forEachNormalized(gray, width, height, bg, (i, n) => {
    normalized[i] = n;
  });

  const threshold = Math.min(BW_MAX_THRESHOLD, Math.max(BW_MIN_THRESHOLD, otsuThreshold(normalized)));
  const lo = threshold - BW_SOFTNESS;
  const hi = threshold + BW_SOFTNESS;
  const despeckle = Math.max(width, height) >= DESPECKLE_MIN_SIZE;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const n = normalized[i];
      let val: number;

      if (n >= hi) {
        val = 255;
      } else if (despeckle && n < threshold && isIsolated(normalized, width, height, x, y, threshold)) {
        val = 255;
      } else if (n <= lo) {
        val = 0;
      } else {
        const t = (n - lo) / (hi - lo);
        val = Math.round(255 * t * t * (3 - 2 * t));
      }

      const idx = i * 4;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
    }
  }

  return imageData;
}

function isIsolated(
  values: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  threshold: number
): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
      if (values[ny * width + nx] < threshold) return false;
    }
  }
  return true;
}

const SHARPEN_AMOUNT = 0.6;

function sharpenRadius(width: number, height: number): number {
  return Math.max(1, Math.round(Math.max(width, height) / 1500));
}

/**
 * Magic Color filter: removes shadows and uneven lighting, whitens the paper, deepens ink and
 * sharpens text while preserving colored logos, stamps, and signatures.
 */
export function applyMagicColor(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const numPixels = width * height;
  const gray = toLuminance(data, numPixels);
  const bg = estimateBackground(gray, width, height);

  const normalized = new Float32Array(numPixels);
  forEachNormalized(gray, width, height, bg, (i, n, scale) => {
    normalized[i] = n;
    const idx = i * 4;
    data[idx] = data[idx] * scale;
    data[idx + 1] = data[idx + 1] * scale;
    data[idx + 2] = data[idx + 2] * scale;
  });

  const blurred = boxBlur(normalized, width, height, sharpenRadius(width, height));
  const lut = buildToneLut(25, 228, 1.3);

  for (let i = 0; i < numPixels; i++) {
    const detail = SHARPEN_AMOUNT * (normalized[i] - blurred[i]);
    const idx = i * 4;
    data[idx] = lut[Math.min(255, Math.max(0, Math.round(data[idx] + detail)))];
    data[idx + 1] = lut[Math.min(255, Math.max(0, Math.round(data[idx + 1] + detail)))];
    data[idx + 2] = lut[Math.min(255, Math.max(0, Math.round(data[idx + 2] + detail)))];
  }

  return imageData;
}

/**
 * Grayscale document filter: same illumination flattening, sharpening and tone curve as Magic
 * Color, without the color.
 */
export function applyDocumentGrayscale(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const numPixels = width * height;
  const gray = toLuminance(data, numPixels);
  const bg = estimateBackground(gray, width, height);

  const normalized = new Float32Array(numPixels);
  forEachNormalized(gray, width, height, bg, (i, n) => {
    normalized[i] = n;
  });

  const blurred = boxBlur(normalized, width, height, sharpenRadius(width, height));
  const lut = buildToneLut(20, 228, 1.2);

  for (let i = 0; i < numPixels; i++) {
    const v = normalized[i] + SHARPEN_AMOUNT * (normalized[i] - blurred[i]);
    const val = lut[Math.min(255, Math.max(0, Math.round(v)))];
    const idx = i * 4;
    data[idx] = val;
    data[idx + 1] = val;
    data[idx + 2] = val;
  }

  return imageData;
}

/**
 * Applies selected filter to the source image Blob.
 */
export async function applyFilter(
  sourceBlob: Blob,
  filter: ImageFilter,
  quality = 0.92
): Promise<Blob> {
  if (filter === 'original') return sourceBlob;

  const img = await loadImage(sourceBlob);
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(img, 0, 0);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  if (filter === 'grayscale') {
    applyDocumentGrayscale(imageData);
  } else if (filter === 'bw') {
    applyBlackAndWhite(imageData);
  } else if (filter === 'magic') {
    applyMagicColor(imageData);
  }

  ctx.putImageData(imageData, 0, 0);
  // JPEG artifacts smear around high-contrast text edges; B&W compresses well as PNG anyway.
  return canvasToBlob(canvas, filter === 'bw' ? 'image/png' : 'image/jpeg', quality);
}

export async function cropImage(
  sourceBlob: Blob,
  cropRect: { x: number; y: number; width: number; height: number },
  quality = 0.92
): Promise<Blob> {
  const img = await loadImage(sourceBlob);
  const canvas = document.createElement('canvas');
  canvas.width = cropRect.width;
  canvas.height = cropRect.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(
    img,
    cropRect.x,
    cropRect.y,
    cropRect.width,
    cropRect.height,
    0,
    0,
    cropRect.width,
    cropRect.height
  );

  return canvasToBlob(canvas, 'image/jpeg', quality);
}

export async function createThumbnail(
  sourceBlob: Blob,
  maxSize = 200,
  quality = 0.7
): Promise<Blob> {
  const img = await loadImage(sourceBlob);
  const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvasToBlob(canvas, 'image/jpeg', quality);
}

/**
 * `blob` scaled down so that neither side exceeds `maxDimension`, or `blob` itself when it
 * already fits. Coordinates measured on the result map back to the source divided by `scale`.
 */
export async function fitImage(
  blob: Blob,
  maxDimension: number,
  quality = 0.9
): Promise<{ blob: Blob; scale: number }> {
  const img = await loadImage(blob);
  const scale = Math.min(1, maxDimension / Math.max(img.width, img.height));
  if (scale === 1) return { blob, scale };

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not get canvas context');

  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const fitted = await canvasToBlob(canvas, blob.type === 'image/png' ? 'image/png' : 'image/jpeg', quality);
  return { blob: fitted, scale };
}

export function blobToObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}
