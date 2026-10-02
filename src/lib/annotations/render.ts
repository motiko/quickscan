import type { Annotation } from '@/types';
import { TEXT_LINE_HEIGHT } from './geometry';

export const TEXT_FONT_FAMILY = '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif';
export const HIGHLIGHTER_ALPHA = 0.35;

export type SignatureImages = Map<string, CanvasImageSource>;

export function textFont(fontPx: number): string {
  return `${fontPx}px ${TEXT_FONT_FAMILY}`;
}

function drawArrowHead(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, size: number) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle - Math.PI / 7), y2 - size * Math.sin(angle - Math.PI / 7));
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - size * Math.cos(angle + Math.PI / 7), y2 - size * Math.sin(angle + Math.PI / 7));
  ctx.stroke();
}

function drawAnnotation(
  ctx: CanvasRenderingContext2D,
  a: Annotation,
  W: number,
  H: number,
  signatures: SignatureImages
) {
  ctx.save();
  switch (a.type) {
    case 'stroke': {
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(1, a.width * W);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (a.tool === 'highlighter') {
        ctx.globalAlpha = HIGHLIGHTER_ALPHA;
        ctx.globalCompositeOperation = 'multiply';
      }
      const pts = a.points.map((p) => ({ x: p.x * W, y: p.y * H }));
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      if (pts.length === 1) {
        ctx.lineTo(pts[0].x + 0.01, pts[0].y);
      } else {
        // Smooth through midpoints so fast strokes don't look jagged
        for (let i = 1; i < pts.length - 1; i++) {
          const mx = (pts[i].x + pts[i + 1].x) / 2;
          const my = (pts[i].y + pts[i + 1].y) / 2;
          ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
        }
        const last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
      }
      ctx.stroke();
      break;
    }
    case 'rect':
      ctx.strokeStyle = a.color;
      ctx.lineWidth = Math.max(1, a.width * W);
      ctx.lineJoin = 'round';
      ctx.strokeRect(a.x * W, a.y * H, a.w * W, a.h * H);
      break;
    case 'arrow': {
      const lw = Math.max(1, a.width * W);
      ctx.strokeStyle = a.color;
      ctx.lineWidth = lw;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      const [x1, y1, x2, y2] = [a.x1 * W, a.y1 * H, a.x2 * W, a.y2 * H];
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      drawArrowHead(ctx, x1, y1, x2, y2, Math.max(10, lw * 4));
      break;
    }
    case 'text': {
      const fontPx = a.fontSize * W;
      ctx.fillStyle = a.color;
      ctx.font = textFont(fontPx);
      ctx.textBaseline = 'top';
      a.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, a.x * W, a.y * H + i * fontPx * TEXT_LINE_HEIGHT);
      });
      break;
    }
    case 'signature': {
      const img = signatures.get(a.signatureId);
      if (img) ctx.drawImage(img, a.x * W, a.y * H, a.w * W, a.h * H);
      break;
    }
  }
  ctx.restore();
}

/** Draw annotations onto a context whose drawing area is W×H pixels. */
export function drawAnnotations(
  ctx: CanvasRenderingContext2D,
  annotations: Annotation[],
  W: number,
  H: number,
  signatures: SignatureImages
): void {
  for (const a of annotations) drawAnnotation(ctx, a, W, H, signatures);
}

/** Text measurer bound to a canvas context, for hit-testing text boxes accurately. */
export function canvasMeasure(ctx: CanvasRenderingContext2D) {
  return (text: string, fontPx: number) => {
    ctx.save();
    ctx.font = textFont(fontPx);
    const w = ctx.measureText(text).width;
    ctx.restore();
    return w;
  };
}
