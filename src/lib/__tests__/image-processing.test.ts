import { describe, it, expect } from 'vitest';
import {
  getQuadDimensions,
  getInversePerspectiveMatrix,
  applyBlackAndWhite,
  applyMagicColor,
  applyDocumentGrayscale,
  estimateBackground,
} from '../image-processing';
import { measureSharpness } from '../camera';
import type { Quad } from '@/types';

describe('image-processing', () => {
  describe('getQuadDimensions', () => {
    it('calculates width and height correctly for a flat rectangle', () => {
      const quad: Quad = [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 200 },
        { x: 0, y: 200 },
      ];
      const dims = getQuadDimensions(quad);
      expect(dims.width).toBe(100);
      expect(dims.height).toBe(200);
    });

    it('handles skewed quad by taking maximum dimensions', () => {
      const quad: Quad = [
        { x: 10, y: 20 },
        { x: 110, y: 25 },
        { x: 120, y: 230 },
        { x: 15, y: 220 },
      ];
      const dims = getQuadDimensions(quad);
      expect(dims.width).toBeGreaterThan(95);
      expect(dims.height).toBeGreaterThan(190);
    });
  });

  describe('getInversePerspectiveMatrix', () => {
    it('generates a 9-element 3x3 homography matrix', () => {
      const quad: Quad = [
        { x: 0, y: 0 },
        { x: 300, y: 0 },
        { x: 300, y: 400 },
        { x: 0, y: 400 },
      ];
      const matrix = getInversePerspectiveMatrix(300, 400, quad);
      expect(matrix).toHaveLength(9);
      expect(matrix[8]).toBe(1.0);
    });

    it('correctly maps origin point in inverse matrix', () => {
      const quad: Quad = [
        { x: 50, y: 60 },
        { x: 250, y: 60 },
        { x: 250, y: 360 },
        { x: 50, y: 360 },
      ];
      const matrix = getInversePerspectiveMatrix(200, 300, quad);
      // For (0, 0): (h02, h12) should be the top-left coordinate (50, 60)
      expect(matrix[2]).toBeCloseTo(50);
      expect(matrix[5]).toBeCloseTo(60);
    });
  });

  // Synthetic page: paper darkened by a left-to-right shadow, with a dark "text" bar in each half.
  function makeShadowedPage(width = 200, height = 100): ImageData {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const light = 0.45 + 0.55 * (x / (width - 1));
        const isText = y >= 45 && y < 50 && ((x >= 20 && x < 60) || (x >= 140 && x < 180));
        const base = isText ? 40 : 240;
        const idx = (y * width + x) * 4;
        data[idx] = base * light;
        data[idx + 1] = base * light;
        data[idx + 2] = base * light;
        data[idx + 3] = 255;
      }
    }
    return { width, height, data } as unknown as ImageData;
  }

  const px = (img: ImageData, x: number, y: number) => img.data[(y * img.width + x) * 4];

  describe('estimateBackground', () => {
    it('follows paper brightness and ignores thin dark ink', () => {
      const page = makeShadowedPage();
      const gray = new Float32Array(page.width * page.height);
      for (let i = 0; i < gray.length; i++) gray[i] = page.data[i * 4];

      const bg = estimateBackground(gray, page.width, page.height);
      const at = (x: number, y: number) =>
        bg.values[Math.floor(y / bg.blockSize) * bg.cols + Math.floor(x / bg.blockSize)];

      // Background over the text bar stays close to the surrounding paper, not the ink.
      expect(at(40, 47)).toBeGreaterThan(gray[40 * page.width + 40] * 0.9);
      // Shadowed side is darker than lit side.
      expect(at(10, 10)).toBeLessThan(at(190, 10));
    });
  });

  describe('applyBlackAndWhite', () => {
    it('whitens shadowed paper and keeps text black on both sides', () => {
      const result = applyBlackAndWhite(makeShadowedPage());

      expect(result.width).toBe(200);
      expect(result.height).toBe(100);
      expect(px(result, 5, 10)).toBe(255);
      expect(px(result, 195, 10)).toBe(255);
      expect(px(result, 40, 47)).toBe(0);
      expect(px(result, 160, 47)).toBe(0);
    });
  });

  describe('applyDocumentGrayscale', () => {
    it('flattens shadow so paper is uniform and text stays dark', () => {
      const result = applyDocumentGrayscale(makeShadowedPage());

      expect(Math.abs(px(result, 5, 10) - px(result, 195, 10))).toBeLessThan(10);
      expect(px(result, 5, 10)).toBeGreaterThan(240);
      expect(px(result, 40, 47)).toBeLessThan(80);
    });
  });

  describe('applyMagicColor', () => {
    it('preserves alpha and scales RGB appropriately', () => {
      const width = 32;
      const height = 32;
      const data = new Uint8ClampedArray(width * height * 4);

      for (let i = 0; i < data.length; i += 4) {
        data[i] = 150;     // R
        data[i + 1] = 180; // G
        data[i + 2] = 200; // B
        data[i + 3] = 255; // A
      }

      const imgData = { width, height, data } as unknown as ImageData;
      const result = applyMagicColor(imgData);

      expect(result.data[3]).toBe(255);
      expect(result.data[0]).toBeGreaterThanOrEqual(0);
      expect(result.data[0]).toBeLessThanOrEqual(255);
    });

    it('whitens shadowed paper while keeping a colored stamp colored', () => {
      const page = makeShadowedPage();
      // Red stamp in the shadowed half.
      for (let y = 10; y < 16; y++) {
        for (let x = 20; x < 26; x++) {
          const idx = (y * page.width + x) * 4;
          page.data[idx] = 120;
          page.data[idx + 1] = 20;
          page.data[idx + 2] = 20;
        }
      }
      const result = applyMagicColor(page);

      expect(px(result, 5, 30)).toBeGreaterThan(240);
      const stamp = (22 + 12 * page.width) * 4;
      expect(result.data[stamp]).toBeGreaterThan(result.data[stamp + 1] + 80);
    });
  });

  describe('measureSharpness', () => {
    it('scores crisp edges higher than blurred ones', () => {
      const make = (blurred: boolean) => {
        const width = 40;
        const height = 40;
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            const v = blurred
              ? 255 * Math.min(1, Math.max(0, (x - 15) / 10))
              : x < 20 ? 0 : 255;
            const idx = (y * width + x) * 4;
            data[idx] = data[idx + 1] = data[idx + 2] = v;
            data[idx + 3] = 255;
          }
        }
        return { width, height, data } as unknown as ImageData;
      };
      expect(measureSharpness(make(false))).toBeGreaterThan(measureSharpness(make(true)));
    });
  });
});
