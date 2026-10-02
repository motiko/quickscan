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

/**
 * Warps a quadrilateral section of an image into a rectified flat rectangle.
 */
export function warpPerspective(
  sourceBlob: Blob,
  corners: Quad,
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const { width: dstW, height: dstH } = getQuadDimensions(corners);

        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = img.width;
        srcCanvas.height = img.height;
        const srcCtx = srcCanvas.getContext('2d');
        if (!srcCtx) {
          reject(new Error('Failed to get source 2D canvas context'));
          return;
        }
        srcCtx.drawImage(img, 0, 0);

        const srcImageData = srcCtx.getImageData(0, 0, img.width, img.height);
        const srcData = srcImageData.data;
        const srcW = img.width;
        const srcH = img.height;

        const dstCanvas = document.createElement('canvas');
        dstCanvas.width = dstW;
        dstCanvas.height = dstH;
        const dstCtx = dstCanvas.getContext('2d');
        if (!dstCtx) {
          reject(new Error('Failed to get destination 2D canvas context'));
          return;
        }

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
        dstCanvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Failed to create warped blob'))),
          'image/jpeg',
          quality
        );
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error('Failed to load source image for warping'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

/**
 * Rotates an image clockwise by 90, 180, or 270 degrees.
 */
export function rotateImage(
  sourceBlob: Blob,
  degrees: 90 | 180 | 270,
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const is90or270 = degrees === 90 || degrees === 270;
      const canvas = document.createElement('canvas');
      canvas.width = is90or270 ? img.height : img.width;
      canvas.height = is90or270 ? img.width : img.height;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((degrees * Math.PI) / 180);
      ctx.drawImage(img, -img.width / 2, -img.height / 2);

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to export rotated image'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image for rotation'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

/**
 * Local adaptive Bradley-Roth thresholding for clean, shadow-free black and white documents.
 */
export function applyAdaptiveThreshold(
  imageData: ImageData,
  windowRatio = 1 / 16,
  thresholdT = 0.15
): ImageData {
  const { width, height, data } = imageData;
  const numPixels = width * height;

  // Grayscale representation
  const gray = new Uint8Array(numPixels);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  // Integral image
  const integral = new Float64Array((width + 1) * (height + 1));
  const intW = width + 1;

  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const yOffset = (y + 1) * intW;
    const prevYOffset = y * intW;
    const grayOffset = y * width;

    for (let x = 0; x < width; x++) {
      rowSum += gray[grayOffset + x];
      integral[yOffset + (x + 1)] = integral[prevYOffset + (x + 1)] + rowSum;
    }
  }

  const s = Math.max(4, Math.floor((width * windowRatio) / 2));

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - s);
    const y2 = Math.min(height - 1, y + s);
    const grayRow = y * width;
    const dataRow = y * width * 4;

    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - s);
      const x2 = Math.min(width - 1, x + s);

      const count = (x2 - x1 + 1) * (y2 - y1 + 1);

      const sum =
        integral[(y2 + 1) * intW + (x2 + 1)] -
        integral[y1 * intW + (x2 + 1)] -
        integral[(y2 + 1) * intW + x1] +
        integral[y1 * intW + x1];

      const pixelVal = gray[grayRow + x];
      const isBlack = pixelVal * count <= sum * (1 - thresholdT);
      const val = isBlack ? 0 : 255;

      const idx = dataRow + x * 4;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
    }
  }

  return imageData;
}

/**
 * Magic Color filter: levels uneven document background illumination while sharpening text
 * and preserving colored logos, stamps, and signatures.
 */
export function applyMagicColor(imageData: ImageData): ImageData {
  const { width, height, data } = imageData;
  const numPixels = width * height;

  const gray = new Uint8Array(numPixels);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = Math.round(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
  }

  // Fast block background luminance estimator
  const blockSize = Math.max(8, Math.floor(Math.min(width, height) / 16));
  const blocksX = Math.ceil(width / blockSize);
  const blocksY = Math.ceil(height / blockSize);
  const bgLuminance = new Float32Array(blocksX * blocksY);

  for (let by = 0; by < blocksY; by++) {
    const yStart = by * blockSize;
    const yEnd = Math.min(height, yStart + blockSize);
    for (let bx = 0; bx < blocksX; bx++) {
      const xStart = bx * blockSize;
      const xEnd = Math.min(width, xStart + blockSize);

      let maxVal = 0;
      for (let y = yStart; y < yEnd; y += 2) {
        const row = y * width;
        for (let x = xStart; x < xEnd; x += 2) {
          const val = gray[row + x];
          if (val > maxVal) maxVal = val;
        }
      }
      bgLuminance[by * blocksX + bx] = Math.max(50, maxVal);
    }
  }

  for (let y = 0; y < height; y++) {
    const by = Math.min(blocksY - 1, Math.floor(y / blockSize));
    const rowOffset = y * width * 4;

    for (let x = 0; x < width; x++) {
      const bx = Math.min(blocksX - 1, Math.floor(x / blockSize));
      const bg = bgLuminance[by * blocksX + bx];
      const scale = 250 / bg;

      const idx = rowOffset + x * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Whiten background while preserving color saturation
      data[idx] = Math.min(255, Math.max(0, Math.round(r * scale)));
      data[idx + 1] = Math.min(255, Math.max(0, Math.round(g * scale)));
      data[idx + 2] = Math.min(255, Math.max(0, Math.round(b * scale)));
    }
  }

  return imageData;
}

/**
 * Applies selected filter to the source image Blob.
 */
export function applyFilter(
  sourceBlob: Blob,
  filter: ImageFilter,
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (filter === 'original') {
      resolve(sourceBlob);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      if (filter === 'grayscale') {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
          const g = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
          data[i] = g;
          data[i + 1] = g;
          data[i + 2] = g;
        }
      } else if (filter === 'bw') {
        applyAdaptiveThreshold(imageData);
      } else if (filter === 'magic') {
        applyMagicColor(imageData);
      }

      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to create filtered blob'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image for filter'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

export function cropImage(
  sourceBlob: Blob,
  cropRect: { x: number; y: number; width: number; height: number },
  quality = 0.92
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = cropRect.width;
      canvas.height = cropRect.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

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

      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to crop'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

export function createThumbnail(
  sourceBlob: Blob,
  maxSize = 200,
  quality = 0.7
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Could not get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('Failed to create thumbnail'))),
        'image/jpeg',
        quality
      );
    };
    img.onerror = () => reject(new Error('Failed to load image'));
    img.src = URL.createObjectURL(sourceBlob);
  });
}

export function blobToObjectUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}
