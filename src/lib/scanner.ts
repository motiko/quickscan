import type { Point, Quad } from '@/types';
import { scanDocument } from 'scanic';

export interface DetectionOptions {
  detector?: 'classical' | 'ml';
  minConfidence?: number;
}

// Orders 4 points into [topLeft, topRight, bottomRight, bottomLeft]
export function orderCorners(points: Point[]): Quad {
  if (points.length !== 4) {
    throw new Error('Must provide exactly 4 points to order');
  }

  // Sort by (x + y) and (y - x)
  const sum = points.map((p) => p.x + p.y);
  const diff = points.map((p) => p.y - p.x);

  let tlIdx = 0;
  let brIdx = 0;
  let trIdx = 0;
  let blIdx = 0;

  for (let i = 1; i < 4; i++) {
    if (sum[i] < sum[tlIdx]) tlIdx = i;
    if (sum[i] > sum[brIdx]) brIdx = i;
    if (diff[i] < diff[trIdx]) trIdx = i;
    if (diff[i] > diff[blIdx]) blIdx = i;
  }

  return [points[tlIdx], points[trIdx], points[brIdx], points[blIdx]];
}

// Perpendicular distance from point p to line (p1, p2)
export function pDistance(p: Point, p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - p1.x, p.y - p1.y);

  const num = Math.abs(dy * p.x - dx * p.y + p2.x * p1.y - p2.y * p1.x);
  return num / Math.sqrt(lengthSq);
}

// Ramer-Douglas-Peucker polygon simplification
export function rdp(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;

  let dmax = 0;
  let index = 0;
  const end = points.length - 1;

  for (let i = 1; i < end; i++) {
    const d = pDistance(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }

  if (dmax > epsilon) {
    const rec1 = rdp(points.slice(0, index + 1), epsilon);
    const rec2 = rdp(points.slice(index), epsilon);
    return rec1.slice(0, -1).concat(rec2);
  } else {
    return [points[0], points[end]];
  }
}

// 2D Cross product of OA and OB vectors
export function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

// Monotone chain 2D convex hull algorithm
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 3) return points;

  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const lower: Point[] = [];
  for (let i = 0; i < pts.length; i++) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pts[i]) <= 0) {
      lower.pop();
    }
    lower.push(pts[i]);
  }

  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pts[i]) <= 0) {
      upper.pop();
    }
    upper.push(pts[i]);
  }

  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// Polygon area (shoelace formula)
export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

// Document edge detector from raw ImageData
export function detectDocumentQuad(imageData: ImageData): { corners: Quad; confidence: number } | null {
  const { width: W, height: H, data } = imageData;
  const numPixels = W * H;

  // 1. Grayscale luminance
  const gray = new Uint8Array(numPixels);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }

  // 2. Sobel gradient magnitude
  const edgePoints: Point[] = [];
  const stride = W;
  const step = 2; // Sample every 2 pixels for performance

  let meanGradient = 0;
  let gradientCount = 0;

  for (let y = 2; y < H - 2; y += step) {
    const row = y * stride;
    for (let x = 2; x < W - 2; x += step) {
      // 3x3 Sobel
      const gx =
        -gray[row - stride + x - 1] + gray[row - stride + x + 1] +
        -2 * gray[row + x - 1] + 2 * gray[row + x + 1] +
        -gray[row + stride + x - 1] + gray[row + stride + x + 1];

      const gy =
        -gray[row - stride + x - 1] - 2 * gray[row - stride + x] - gray[row - stride + x + 1] +
        gray[row + stride + x - 1] + 2 * gray[row + stride + x] + gray[row + stride + x + 1];

      const mag = Math.abs(gx) + Math.abs(gy);
      meanGradient += mag;
      gradientCount++;

      if (mag > 120) {
        edgePoints.push({ x, y });
      }
    }
  }

  const avgGradient = gradientCount > 0 ? meanGradient / gradientCount : 0;
  const totalArea = W * H;

  if (edgePoints.length < 20) {
    return null;
  }

  // 3. Convex hull
  const hull = convexHull(edgePoints);
  if (hull.length < 4) return null;

  // 4. Polygon approximation
  const perimeter = hull.reduce((acc, p, idx) => {
    const next = hull[(idx + 1) % hull.length];
    return acc + Math.hypot(next.x - p.x, next.y - p.y);
  }, 0);

  let simplified = rdp(hull, perimeter * 0.035);

  // If simplified doesn't have 4 points, search epsilon to get 4 points
  if (simplified.length !== 4) {
    for (let factor = 0.02; factor <= 0.08; factor += 0.01) {
      const candidate = rdp(hull, perimeter * factor);
      if (candidate.length === 4) {
        simplified = candidate;
        break;
      }
    }
  }

  if (simplified.length === 4) {
    const area = polygonArea(simplified);
    const areaRatio = area / totalArea;

    // A valid document occupies 15% to 92% of the viewfinder
    if (areaRatio >= 0.15 && areaRatio <= 0.95) {
      const ordered = orderCorners(simplified);
      const confidence = Math.min(1, (areaRatio / 0.7) * (avgGradient > 20 ? 1 : 0.8));
      return { corners: ordered, confidence };
    }
  }

  return null;
}

/**
 * Asynchronously detects document corners in an ImageData frame.
 * Uses high-performance WebAssembly edge detection with multi-pass contour cascades,
 * or optional neural coordinate classification (DocCornerNet) for challenging scenes.
 */
export async function detectDocumentQuadAsync(
  imageData: ImageData,
  options: DetectionOptions = {}
): Promise<{ corners: Quad; confidence: number } | null> {
  const { detector = 'classical', minConfidence = 0.3 } = options;

  try {
    const result = await scanDocument(imageData, {
      mode: 'detect',
      detector,
      minDetectionConfidence: minConfidence,
      minDocumentCoverageRatio: 0.15,
      maxProcessingDimension: 600,
    });

    if (result.success && result.corners) {
      const { topLeft, topRight, bottomRight, bottomLeft } = result.corners;
      const rawPoints: Point[] = [topLeft, topRight, bottomRight, bottomLeft];
      const ordered = orderCorners(rawPoints);
      const confidence = result.confidence ?? (result.score ?? 0.85);

      return {
        corners: ordered,
        confidence: Math.max(0, Math.min(1, confidence)),
      };
    }
  } catch (err) {
    console.warn('WASM document detection error, trying fallback:', err);
  }

  return detectDocumentQuad(imageData);
}
