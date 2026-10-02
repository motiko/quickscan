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

/**
 * Scores how well the detected quad's area covers the image.
 * Sweet spot is 20–80% coverage; too small or too large penalised.
 */
export function scoreAreaRatio(corners: Quad, imageWidth: number, imageHeight: number): number {
  const area = polygonArea(corners);
  const totalArea = imageWidth * imageHeight;
  const ratio = area / totalArea;

  if (ratio < 0.15) return 0;
  if (ratio <= 0.20) return ((ratio - 0.15) / 0.05) * 0.5;
  if (ratio <= 0.80) return 1.0;
  if (ratio <= 0.95) return 1.0 - ((ratio - 0.80) / 0.15) * 0.7;
  return 0;
}

/**
 * Scores how close each interior corner angle is to 90°.
 * Uses dot-product to compute the angle at each of the 4 vertices.
 */
export function scoreCornerAngles(corners: Quad): number {
  let totalScore = 0;

  for (let i = 0; i < 4; i++) {
    const prev = corners[(i + 3) % 4];
    const curr = corners[i];
    const next = corners[(i + 1) % 4];

    const ax = prev.x - curr.x;
    const ay = prev.y - curr.y;
    const bx = next.x - curr.x;
    const by = next.y - curr.y;

    const dot = ax * bx + ay * by;
    const magA = Math.sqrt(ax * ax + ay * ay);
    const magB = Math.sqrt(bx * bx + by * by);

    if (magA === 0 || magB === 0) {
      totalScore += 0;
      continue;
    }

    const cosAngle = Math.max(-1, Math.min(1, dot / (magA * magB)));
    const angleDeg = Math.acos(cosAngle) * (180 / Math.PI);

    // Perfect = 90°, linearly falls to 0 at ±45° (i.e. at 45° or 135°)
    const deviation = Math.abs(angleDeg - 90);
    const cornerScore = Math.max(0, 1 - deviation / 45);
    totalScore += cornerScore;
  }

  return totalScore / 4;
}

/**
 * Scores how document-like the aspect ratio is (width/height between 0.5–2.5).
 */
export function scoreAspectRatio(corners: Quad): number {
  const [tl, tr, br, bl] = corners;

  const topLen = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottomLen = Math.hypot(br.x - bl.x, br.y - bl.y);
  const leftLen = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const rightLen = Math.hypot(br.x - tr.x, br.y - tr.y);

  const w = (topLen + bottomLen) / 2;
  const h = (leftLen + rightLen) / 2;

  if (h === 0 || w === 0) return 0;

  // Normalise so ratio >= 1
  const ratio = w > h ? w / h : h / w;

  if (ratio <= 2.0) return 1.0;
  if (ratio <= 2.5) return 1.0 - ((ratio - 2.0) / 0.5) * 0.5;
  if (ratio <= 3.5) return 0.5 - ((ratio - 2.5) / 1.0) * 0.5;
  return 0;
}

/** Cross-product winding test to check if a point lies inside a quad. */
function isPointInsideQuad(p: Point, quad: Quad): boolean {
  for (let i = 0; i < 4; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % 4];
    const crossVal = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (crossVal < 0) return false;
  }
  return true;
}

/**
 * Scores brightness contrast between document interior and image exterior.
 * High contrast → more likely a real document.
 */
export function scoreContrast(corners: Quad, imageData: ImageData): number {
  const { width: W, height: H, data } = imageData;

  // --- Helper: luminance at pixel ---
  const lum = (x: number, y: number): number => {
    const idx = (y * W + x) * 4;
    return (data[idx] * 77 + data[idx + 1] * 150 + data[idx + 2] * 29) >> 8;
  };

  // --- Bounding box of quad ---
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  minX = Math.max(0, Math.floor(minX));
  maxX = Math.min(W - 1, Math.floor(maxX));
  minY = Math.max(0, Math.floor(minY));
  maxY = Math.min(H - 1, Math.floor(maxY));

  // --- Sample ~50 interior points ---
  let insideSum = 0;
  let insideCount = 0;
  const insideTarget = 50;
  const bboxW = maxX - minX;
  const bboxH = maxY - minY;

  if (bboxW > 0 && bboxH > 0) {
    // Deterministic grid sampling with enough candidates
    const gridStep = Math.max(1, Math.floor(Math.sqrt((bboxW * bboxH) / (insideTarget * 3))));
    for (let y = minY; y <= maxY && insideCount < insideTarget; y += gridStep) {
      for (let x = minX; x <= maxX && insideCount < insideTarget; x += gridStep) {
        if (isPointInsideQuad({ x, y }, corners)) {
          insideSum += lum(x, y);
          insideCount++;
        }
      }
    }
  }

  // --- Sample ~50 exterior points from border strips (first/last 10%) ---
  let outsideSum = 0;
  let outsideCount = 0;
  const outsideTarget = 50;
  const borderX = Math.max(1, Math.floor(W * 0.1));
  const borderY = Math.max(1, Math.floor(H * 0.1));

  const stepOuter = Math.max(1, Math.floor(Math.sqrt((2 * (borderX * H + borderY * W)) / (outsideTarget * 3))));

  // Left and right border strips
  for (let y = 0; y < H && outsideCount < outsideTarget; y += stepOuter) {
    for (let x = 0; x < borderX && outsideCount < outsideTarget; x += stepOuter) {
      outsideSum += lum(x, y);
      outsideCount++;
    }
  }
  for (let y = 0; y < H && outsideCount < outsideTarget; y += stepOuter) {
    for (let x = W - borderX; x < W && outsideCount < outsideTarget; x += stepOuter) {
      outsideSum += lum(x, y);
      outsideCount++;
    }
  }
  // Top and bottom border strips
  for (let x = borderX; x < W - borderX && outsideCount < outsideTarget; x += stepOuter) {
    for (let y = 0; y < borderY && outsideCount < outsideTarget; y += stepOuter) {
      outsideSum += lum(x, y);
      outsideCount++;
    }
  }
  for (let x = borderX; x < W - borderX && outsideCount < outsideTarget; x += stepOuter) {
    for (let y = H - borderY; y < H && outsideCount < outsideTarget; y += stepOuter) {
      outsideSum += lum(x, y);
      outsideCount++;
    }
  }

  if (insideCount === 0 || outsideCount === 0) return 0;

  const insideAvg = insideSum / insideCount;
  const outsideAvg = outsideSum / outsideCount;

  return Math.min(1, Math.abs(insideAvg - outsideAvg) / 80);
}

/**
 * Combines area, angle, contrast, and aspect-ratio scores into an overall
 * document-detection confidence in [0, 1].
 */
export function computeDocumentConfidence(corners: Quad, imageData: ImageData): number {
  const areaScore = scoreAreaRatio(corners, imageData.width, imageData.height);
  const angleScore = scoreCornerAngles(corners);
  const contrastScore = scoreContrast(corners, imageData);
  const aspectScore = scoreAspectRatio(corners);

  const raw = areaScore * 0.25 + angleScore * 0.25 + contrastScore * 0.30 + aspectScore * 0.20;
  return Math.max(0, Math.min(1, raw));
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

      if (mag > 120) {
        edgePoints.push({ x, y });
      }
    }
  }

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
      const confidence = computeDocumentConfidence(ordered, imageData);
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
