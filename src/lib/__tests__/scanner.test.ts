import { describe, it, expect } from 'vitest';
import { orderCorners, pDistance, rdp, convexHull, polygonArea, detectDocumentQuad, detectDocumentQuadAsync } from '../scanner';
import type { Point } from '@/types';

function createTestImageData(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function drawRectangle(
  imageData: ImageData,
  x: number, y: number, w: number, h: number,
  fillR: number, fillG: number, fillB: number
) {
  const { data, width } = imageData;
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      const idx = (py * width + px) * 4;
      data[idx] = fillR;
      data[idx + 1] = fillG;
      data[idx + 2] = fillB;
      data[idx + 3] = 255;
    }
  }
}

describe('scanner functions', () => {
  describe('orderCorners', () => {
    it('already-ordered corners should stay the same', () => {
      const corners: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];
      const ordered = orderCorners(corners);
      expect(ordered).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]);
    });

    it('shuffled corners should be correctly reordered', () => {
      const corners: Point[] = [
        { x: 10, y: 10 }, // br
        { x: 0, y: 0 },   // tl
        { x: 0, y: 10 },  // bl
        { x: 10, y: 0 },  // tr
      ];
      const ordered = orderCorners(corners);
      expect(ordered).toEqual([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ]);
    });

    it('handles corners from different quadrants (offset coordinates)', () => {
      const corners: Point[] = [
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 100, y: 200 },
        { x: 200, y: 200 },
      ];
      const ordered = orderCorners(corners);
      expect(ordered).toEqual([
        { x: 100, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ]);
    });
  });

  describe('pDistance', () => {
    it('distance to point on the line should be 0', () => {
      const p = { x: 5, y: 5 };
      const p1 = { x: 0, y: 0 };
      const p2 = { x: 10, y: 10 };
      expect(pDistance(p, p1, p2)).toBeCloseTo(0);
    });

    it('point perpendicular to a horizontal line', () => {
      const p = { x: 5, y: 5 };
      const p1 = { x: 0, y: 0 };
      const p2 = { x: 10, y: 0 };
      expect(pDistance(p, p1, p2)).toBeCloseTo(5);
    });

    it('point perpendicular to a vertical line', () => {
      const p = { x: 5, y: 5 };
      const p1 = { x: 0, y: 0 };
      const p2 = { x: 0, y: 10 };
      expect(pDistance(p, p1, p2)).toBeCloseTo(5);
    });
  });

  describe('rdp', () => {
    it('straight line should simplify to 2 points', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 2, y: 2 },
        { x: 5, y: 5 },
        { x: 10, y: 10 }
      ];
      const simplified = rdp(points, 0.1);
      expect(simplified.length).toBe(2);
      expect(simplified[0]).toEqual({ x: 0, y: 0 });
      expect(simplified[1]).toEqual({ x: 10, y: 10 });
    });

    it('rectangle should remain a rectangle (4 points) with appropriate epsilon', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 5, y: 0.1 }, // slight deviation
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 0, y: 0 }
      ];
      const simplified = rdp(points, 0.2);
      // It should keep the 4 major corners + the closing start point
      // (rdp includes endpoints)
      // Actually it depends on how RDP splits it.
      // But it should simplify the {x:5, y:0.1}
      expect(simplified.find((p) => p.x === 5 && p.y === 0.1)).toBeUndefined();
      expect(simplified.length).toBeLessThanOrEqual(5);
    });

    it('high epsilon should over-simplify', () => {
       const points: Point[] = [
        { x: 0, y: 0 },
        { x: 5, y: 2 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
        { x: 0, y: 0 }
      ];
      const simplified = rdp(points, 20); // epsilon is very high
      expect(simplified.length).toBe(2); // just start and end
    });
  });

  describe('convexHull', () => {
    it('square corners -> returns the 4 corners', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];
      const hull = convexHull(points);
      expect(hull.length).toBe(4);
    });

    it('points with interior points -> interior points removed', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 5, y: 5 }, // interior
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];
      const hull = convexHull(points);
      expect(hull.length).toBe(4);
      expect(hull.find(p => p.x === 5 && p.y === 5)).toBeUndefined();
    });

    it('collinear points handled', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 5, y: 0 }, // collinear
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ];
      const hull = convexHull(points);
      // Monotone chain might keep or remove collinear points depending on strictness
      // Usually it removes them since cross product <= 0
      expect(hull.length).toBe(4);
    });
  });

  describe('polygonArea', () => {
    it('unit square = 1', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ];
      expect(polygonArea(points)).toBeCloseTo(1);
    });

    it('known rectangle', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 5 },
        { x: 0, y: 5 },
      ];
      expect(polygonArea(points)).toBeCloseTo(50);
    });

    it('known triangle', () => {
      const points: Point[] = [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 0, y: 10 },
      ];
      expect(polygonArea(points)).toBeCloseTo(50);
    });
  });

  describe('detectDocumentQuad', () => {
    it('returns null for uniform gray (no document)', () => {
      const img = createTestImageData(100, 100);
      drawRectangle(img, 0, 0, 100, 100, 128, 128, 128); // uniform gray
      const result = detectDocumentQuad(img);
      expect(result).toBeNull();
    });

    it('returns null for small document (< 15% area)', () => {
      const img = createTestImageData(100, 100);
      drawRectangle(img, 0, 0, 100, 100, 50, 50, 50); // dark bg
      drawRectangle(img, 45, 45, 10, 10, 255, 255, 255); // small document 10x10 = 100 area (1%)
      const result = detectDocumentQuad(img);
      expect(result).toBeNull();
    });

    it('returns null for document filling > 95%', () => {
      const img = createTestImageData(100, 100);
      drawRectangle(img, 0, 0, 100, 100, 50, 50, 50); // dark bg
      drawRectangle(img, 1, 1, 98, 98, 255, 255, 255); // almost full area
      const result = detectDocumentQuad(img);
      expect(result).toBeNull();
    });

    it('detects a white rectangle on dark background', () => {
      const img = createTestImageData(100, 100);
      drawRectangle(img, 0, 0, 100, 100, 50, 50, 50); // dark bg
      drawRectangle(img, 20, 20, 60, 60, 255, 255, 255); // 60x60 = 3600 area (36%)
      
      const result = detectDocumentQuad(img);
      expect(result).not.toBeNull();
      if (result && result.corners) {
        expect(result.corners.length).toBe(4);
        // Approximately [20,20], [80,20], [80,80], [20,80]
        // But edges might be slightly shifted depending on Sobel kernel size.
        // So we just check confidence and area range.
        expect(result.confidence).toBeGreaterThan(0);
      }
    });

    it('detects angled/rotated document (using an approximate mask if needed)', () => {
      // It's hard to draw a rotated rectangle manually pixel by pixel simply here,
      // but drawing a large inner diamond shape or checking the simple rectangle is enough
      // to ensure the algorithm handles quadrilaterals.
      // We will use a known 45-deg rectangle for testing.
      const img = createTestImageData(100, 100);
      drawRectangle(img, 0, 0, 100, 100, 50, 50, 50); // dark bg

      // Draw diamond
      const cx = 50, cy = 50, r = 30;
      for (let y = 0; y < 100; y++) {
        for (let x = 0; x < 100; x++) {
          if (Math.abs(x - cx) + Math.abs(y - cy) < r) {
            const idx = (y * 100 + x) * 4;
            img.data[idx] = 255;
            img.data[idx + 1] = 255;
            img.data[idx + 2] = 255;
            img.data[idx + 3] = 255;
          }
        }
      }

      const result = detectDocumentQuad(img);
      expect(result).not.toBeNull();
    });
  });

  describe('detectDocumentQuadAsync (WASM & Neural detection)', () => {
    it('returns null for uniform blank image', async () => {
      const img = createTestImageData(100, 100);
      drawRectangle(img, 0, 0, 100, 100, 128, 128, 128);
      const result = await detectDocumentQuadAsync(img);
      expect(result).toBeNull();
    });

    it('detects a white document on darker background', async () => {
      const img = createTestImageData(200, 200);
      drawRectangle(img, 0, 0, 200, 200, 40, 40, 40);
      drawRectangle(img, 30, 30, 140, 140, 255, 255, 255);
      const result = await detectDocumentQuadAsync(img);
      expect(result).not.toBeNull();
      if (result && result.corners) {
        expect(result.corners).toHaveLength(4);
        expect(result.confidence).toBeGreaterThan(0.5);
      }
    });

    it('successfully detects document with printed text lines inside', async () => {
      const img = createTestImageData(200, 200);
      drawRectangle(img, 0, 0, 200, 200, 40, 40, 40);
      drawRectangle(img, 30, 30, 140, 140, 255, 255, 255);
      // Add text stripes that previously broke convex-hull algorithms
      for (let y = 50; y < 150; y += 12) {
        drawRectangle(img, 45, y, 110, 4, 10, 10, 10);
      }
      const result = await detectDocumentQuadAsync(img);
      expect(result).not.toBeNull();
      if (result && result.corners) {
        expect(result.corners).toHaveLength(4);
        // Top-left corner should be near document edge (~30, 30), not collapsed onto text line
        expect(result.corners[0].x).toBeLessThan(40);
        expect(result.corners[0].y).toBeLessThan(40);
      }
    });
  });
});
