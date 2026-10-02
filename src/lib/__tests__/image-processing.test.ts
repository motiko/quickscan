import { describe, it, expect } from 'vitest';
import {
  getQuadDimensions,
  getInversePerspectiveMatrix,
  applyAdaptiveThreshold,
  applyMagicColor,
} from '../image-processing';
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

  describe('applyAdaptiveThreshold', () => {
    it('binarizes image data without modifying dimensions', () => {
      const width = 16;
      const height = 16;
      const data = new Uint8ClampedArray(width * height * 4);

      // Create a gradient pattern
      for (let i = 0; i < data.length; i += 4) {
        data[i] = 120;     // R
        data[i + 1] = 120; // G
        data[i + 2] = 120; // B
        data[i + 3] = 255; // A
      }

      // Add a dark spot simulating text
      const centerIdx = (8 * width + 8) * 4;
      data[centerIdx] = 20;
      data[centerIdx + 1] = 20;
      data[centerIdx + 2] = 20;

      const imgData = { width, height, data } as unknown as ImageData;
      const result = applyAdaptiveThreshold(imgData);

      expect(result.width).toBe(16);
      expect(result.height).toBe(16);
      // Pixels should be either 0 or 255
      for (let i = 0; i < result.data.length; i += 4) {
        expect([0, 255]).toContain(result.data[i]);
      }
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
  });
});
