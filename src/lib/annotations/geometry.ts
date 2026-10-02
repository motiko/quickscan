import type { Annotation, Point } from '@/types';

/** Axis-aligned box in pixels. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const TEXT_LINE_HEIGHT = 1.25;
// Rough average glyph width used when no canvas is available to measure text
const APPROX_CHAR_WIDTH = 0.55;

export type MeasureText = (text: string, fontPx: number) => number;

const approxMeasure: MeasureText = (text, fontPx) => text.length * fontPx * APPROX_CHAR_WIDTH;

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Bounding box of an annotation in pixels for a W×H page. */
export function getBounds(a: Annotation, W: number, H: number, measure: MeasureText = approxMeasure): Box {
  switch (a.type) {
    case 'stroke': {
      const xs = a.points.map((p) => p.x * W);
      const ys = a.points.map((p) => p.y * H);
      const pad = (a.width * W) / 2;
      const x = Math.min(...xs) - pad;
      const y = Math.min(...ys) - pad;
      return { x, y, w: Math.max(...xs) + pad - x, h: Math.max(...ys) + pad - y };
    }
    case 'rect':
    case 'signature':
      return { x: a.x * W, y: a.y * H, w: a.w * W, h: a.h * H };
    case 'arrow': {
      const x = Math.min(a.x1, a.x2) * W;
      const y = Math.min(a.y1, a.y2) * H;
      return { x, y, w: Math.abs(a.x2 - a.x1) * W, h: Math.abs(a.y2 - a.y1) * H };
    }
    case 'text': {
      const fontPx = a.fontSize * W;
      const lines = a.text.split('\n');
      const w = Math.max(...lines.map((l) => measure(l, fontPx)), fontPx * 0.5);
      return { x: a.x * W, y: a.y * H, w, h: lines.length * fontPx * TEXT_LINE_HEIGHT };
    }
  }
}

function insideBox(p: Point, b: Box, tolerance: number): boolean {
  return (
    p.x >= b.x - tolerance && p.x <= b.x + b.w + tolerance && p.y >= b.y - tolerance && p.y <= b.y + b.h + tolerance
  );
}

/** Whether a pixel point touches the annotation (strokes and outlines by distance, filled things by box). */
export function hitsAnnotation(
  a: Annotation,
  p: Point,
  W: number,
  H: number,
  tolerance: number,
  measure?: MeasureText
): boolean {
  switch (a.type) {
    case 'stroke': {
      const reach = (a.width * W) / 2 + tolerance;
      const pts = a.points.map((q) => ({ x: q.x * W, y: q.y * H }));
      if (pts.length === 1) return Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
      return pts.some((q, i) => i > 0 && distanceToSegment(p, pts[i - 1], q) <= reach);
    }
    case 'arrow':
      return (
        distanceToSegment(p, { x: a.x1 * W, y: a.y1 * H }, { x: a.x2 * W, y: a.y2 * H }) <=
        (a.width * W) / 2 + tolerance
      );
    case 'rect': {
      // Only the outline counts, so content inside an empty box stays reachable
      const b = getBounds(a, W, H);
      const reach = (a.width * W) / 2 + tolerance;
      const nearEdge =
        Math.min(Math.abs(p.x - b.x), Math.abs(p.x - (b.x + b.w)), Math.abs(p.y - b.y), Math.abs(p.y - (b.y + b.h))) <=
        reach;
      return nearEdge && insideBox(p, b, reach);
    }
    case 'text':
    case 'signature':
      return insideBox(p, getBounds(a, W, H, measure), tolerance);
  }
}

/** Topmost annotation under a pixel point. */
export function hitTest(
  annotations: Annotation[],
  p: Point,
  W: number,
  H: number,
  tolerance: number,
  measure?: MeasureText
): Annotation | null {
  for (let i = annotations.length - 1; i >= 0; i--) {
    if (hitsAnnotation(annotations[i], p, W, H, tolerance, measure)) return annotations[i];
  }
  return null;
}

/** Move by a normalized offset. */
export function translateAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.type) {
    case 'stroke':
      return { ...a, points: a.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
    case 'arrow':
      return { ...a, x1: a.x1 + dx, y1: a.y1 + dy, x2: a.x2 + dx, y2: a.y2 + dy };
    default:
      return { ...a, x: a.x + dx, y: a.y + dy };
  }
}

export function isResizable(a: Annotation): boolean {
  return a.type === 'rect' || a.type === 'signature' || a.type === 'text';
}

/**
 * Resize by dragging the bottom-right corner to a normalized point.
 * Signatures keep their aspect ratio; text scales its font size.
 */
export function resizeAnnotation(
  a: Annotation,
  corner: Point,
  W: number,
  H: number,
  measure?: MeasureText
): Annotation {
  const MIN = 0.02;
  switch (a.type) {
    case 'rect':
      return { ...a, w: Math.max(MIN, corner.x - a.x), h: Math.max(MIN, corner.y - a.y) };
    case 'signature': {
      const aspect = (a.w * W) / (a.h * H);
      const wPx = Math.max(MIN * W, (corner.x - a.x) * W, (corner.y - a.y) * H * aspect);
      return { ...a, w: wPx / W, h: wPx / aspect / H };
    }
    case 'text': {
      const b = getBounds(a, W, H, measure);
      const scale = Math.max(0.2, ((corner.y - a.y) * H) / b.h);
      return { ...a, fontSize: Math.max(0.008, a.fontSize * scale) };
    }
    default:
      return a;
  }
}

/**
 * Re-map annotations after the page image is rotated 90° clockwise.
 * W and H are the dimensions *before* rotation. Text and signatures stay upright
 * and keep their pixel size; they rotate around their centre.
 */
export function rotateAnnotations90(annotations: Annotation[], W: number, H: number): Annotation[] {
  // Clockwise: pixel (px, py) -> (H - py, px); normalized (x, y) -> (1 - y, x)
  const rot = (p: Point): Point => ({ x: 1 - p.y, y: p.x });
  const widthScale = W / H; // fractions of the old width -> fractions of the new width (= old height)

  return annotations.map((a) => {
    switch (a.type) {
      case 'stroke':
        return { ...a, points: a.points.map(rot), width: a.width * widthScale };
      case 'arrow': {
        const p1 = rot({ x: a.x1, y: a.y1 });
        const p2 = rot({ x: a.x2, y: a.y2 });
        return { ...a, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y, width: a.width * widthScale };
      }
      case 'rect':
        return { ...a, x: 1 - (a.y + a.h), y: a.x, w: a.h, h: a.w, width: a.width * widthScale };
      case 'signature': {
        const c = rot({ x: a.x + a.w / 2, y: a.y + a.h / 2 });
        // Same pixel size on the rotated page (new width = H, new height = W)
        const w = (a.w * W) / H;
        const h = (a.h * H) / W;
        return { ...a, x: c.x - w / 2, y: c.y - h / 2, w, h };
      }
      case 'text': {
        const b = getBounds(a, W, H);
        const c = rot({ x: (b.x + b.w / 2) / W, y: (b.y + b.h / 2) / H });
        // New page is H wide and W tall
        return { ...a, x: c.x - b.w / 2 / H, y: c.y - b.h / 2 / W, fontSize: a.fontSize * widthScale };
      }
    }
  });
}
