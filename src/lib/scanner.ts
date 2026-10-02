import type { Point, Quad, DetectedQuad } from '@/types';
import { scanDocument } from 'scanic';
import { MLCornerDetector, Corner } from './ml-detector';

export interface DetectionOptions {
  detector?: 'classical' | 'ml';
  minConfidence?: number;
}

// Instantiate the detector (will be used in the worker)
export const mlDetector = new MLCornerDetector();

// Orders 4 points into [topLeft, topRight, bottomRight, bottomLeft]
export function orderCorners(points: Point[]): Quad {
  if (points.length !== 4) {
    throw new Error('Must provide exactly 4 points to order');
  }

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

export function pDistance(p: Point, p1: Point, p2: Point): number {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSq = dx * dx + dy * dy;
  if (lengthSq === 0) return Math.hypot(p.x - p1.x, p.y - p1.y);

  const num = Math.abs(dy * p.x - dx * p.y + p2.x * p1.y - p2.y * p1.x);
  return num / Math.sqrt(lengthSq);
}

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

export function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
}

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

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const j = (i + 1) % points.length;
    area += points[i].x * points[j].y;
    area -= points[j].x * points[i].y;
  }
  return Math.abs(area) / 2;
}

/**
 * Refines a rough corner coordinate by searching for the nearest high-gradient edge.
 */
function snapToEdge(imageData: ImageData, corner: Corner, searchRadius = 32): Point {
  const { width: W, height: H, data } = imageData;
  let maxGrad = -1;
  let bestPoint = { x: corner.x * W, y: corner.y * H };

  const startX = Math.max(0, Math.floor(corner.x * W) - searchRadius);
  const endX = Math.min(W - 1, Math.floor(corner.x * W) + searchRadius);
  const startY = Math.max(0, Math.floor(corner.y * H) - searchRadius);
  const endY = Math.min(H - 1, Math.floor(corner.y * H) + searchRadius);

  for (let y = startY; y <= endY; y++) {
    for (let x = startX; x <= endX; x++) {
      const idx = (y * W + x) * 4;
      if (idx < 0 || idx >= data.length) continue;

      // Simple gradient check: diff with neighbor
      const current = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      const right = (idx + 4 < data.length) ? (data[idx + 4] + data[idx + 5] + data[idx + 6]) / 3 : current;
      const bottom = (idx + W * 4 < data.length) ? (data[idx + W * 4] + data[idx + W * 4 + 1] + data[idx + W * 4 + 2]) / 3 : current;

      const grad = Math.abs(current - right) + Math.abs(current - bottom);
      if (grad > maxGrad) {
        maxGrad = grad;
        bestPoint = { x, y };
      }
    }
  }
  return bestPoint;
}

export function detectDocumentQuad(imageData: ImageData): { corners: Quad; confidence: number } | null {
  const { width: W, height: H, data } = imageData;
  const numPixels = W * H;

  const gray = new Uint8Array(numPixels);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    gray[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8;
  }

  const edgePoints: Point[] = [];
  const stride = W;
  const step = 2;

  let meanGradient = 0;
  let gradientCount = 0;

  for (let y = 2; y < H - 2; y += step) {
    const row = y * stride;
    for (let x = 2; x < W - 2; x += step) {
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

  const hull = convexHull(edgePoints);
  if (hull.length < 4) return null;

  const perimeter = hull.reduce((acc, p, idx) => {
    const next = hull[(idx + 1) % hull.length];
    return acc + Math.hypot(next.x - p.x, next.y - p.y);
  }, 0);

  let simplified = rdp(hull, perimeter * 0.035);

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

    if (areaRatio >= 0.15 && areaRatio <= 0.95) {
      const ordered = orderCorners(simplified);
      const confidence = Math.min(1, (areaRatio / 0.7) * (avgGradient > 20 ? 1 : 0.8));
      return { corners: ordered, confidence };
    }
  }

  return null;
}

export async function detectDocumentQuadAsync(
  imageData: ImageData,
  options: DetectionOptions = {}
): Promise<DetectedQuad | null> {
  const { detector = 'classical', minConfidence = 0.3 } = options;

  if (detector === 'ml') {
    try {
      const roughCorners = await mlDetector.predict(imageData);
      const refinedCorners = roughCorners.map(c => snapToEdge(imageData, c));
      const ordered = orderCorners(refinedCorners);

      const area = polygonArea(ordered);
      const areaRatio = area / (imageData.width * imageData.height);

      if (areaRatio < 0.15 || areaRatio > 0.95) return null;

      return { corners: ordered, confidence: 0.85 };
    } catch (err) {
      console.warn('ML detection failed, falling back to classical:', err);
    }
  }

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
    console.warn('WASM document detection error, trying fallback:', { err });
  }

  const classical = detectDocumentQuad(imageData);
  return classical ? { ...classical } : null;
}
