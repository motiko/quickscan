import { describe, it, expect } from 'vitest';
import type { Annotation } from '@/types';
import {
  distanceToSegment,
  getBounds,
  hitTest,
  resizeAnnotation,
  rotateAnnotations90,
  translateAnnotation,
} from '@/lib/annotations/geometry';

const W = 1000;
const H = 2000;

const stroke: Annotation = {
  id: 's', type: 'stroke', tool: 'pen', color: '#000', width: 0.01,
  points: [{ x: 0.1, y: 0.1 }, { x: 0.5, y: 0.1 }],
};
const rect: Annotation = { id: 'r', type: 'rect', x: 0.2, y: 0.3, w: 0.4, h: 0.1, color: '#000', width: 0.005 };
const arrow: Annotation = { id: 'a', type: 'arrow', x1: 0.1, y1: 0.9, x2: 0.5, y2: 0.9, color: '#000', width: 0.005 };
const sig: Annotation = { id: 'g', type: 'signature', signatureId: 'x', x: 0.6, y: 0.6, w: 0.3, h: 0.05 };
const text: Annotation = { id: 't', type: 'text', x: 0.1, y: 0.5, text: 'Hello', fontSize: 0.04, color: '#000' };

describe('distanceToSegment', () => {
  it('measures perpendicular and endpoint distances', () => {
    expect(distanceToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 13, y: 4 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(5);
    expect(distanceToSegment({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBe(5);
  });
});

describe('hitTest', () => {
  const all = [rect, stroke, arrow, sig, text];

  it('finds strokes and arrows near their line', () => {
    expect(hitTest(all, { x: 300, y: 205 }, W, H, 8)?.id).toBe('s');
    expect(hitTest(all, { x: 300, y: 1800 }, W, H, 8)?.id).toBe('a');
  });

  it('hits rectangles on the outline only', () => {
    expect(hitTest(all, { x: 200, y: 700 }, W, H, 8)?.id).toBe('r');
    expect(hitTest(all, { x: 400, y: 700 }, W, H, 8)).toBeNull();
  });

  it('hits text and signatures anywhere inside', () => {
    expect(hitTest(all, { x: 750, y: 1250 }, W, H, 8)?.id).toBe('g');
    expect(hitTest(all, { x: 120, y: 1010 }, W, H, 8)?.id).toBe('t');
  });

  it('prefers the topmost annotation', () => {
    const overlap: Annotation = { ...sig, id: 'top', x: 0.65 };
    expect(hitTest([sig, overlap], { x: 700, y: 1250 }, W, H, 8)?.id).toBe('top');
  });
});

describe('translateAnnotation / resizeAnnotation', () => {
  it('moves every kind of annotation', () => {
    expect(translateAnnotation(stroke, 0.1, 0.2)).toMatchObject({ points: [{ x: 0.2, y: 0.30000000000000004 }, { x: 0.6, y: 0.30000000000000004 }] });
    expect(translateAnnotation(arrow, 0.1, 0)).toMatchObject({ x1: 0.2, x2: 0.6 });
    expect(translateAnnotation(rect, 0.1, 0.1)).toMatchObject({ x: 0.30000000000000004, y: 0.4 });
  });

  it('keeps a signature aspect ratio while resizing', () => {
    const resized = resizeAnnotation(sig, { x: 0.9 + 0.3, y: 0.6 }, W, H);
    if (resized.type !== 'signature') throw new Error();
    const before = (sig.w * W) / (0.05 * H);
    expect((resized.w * W) / (resized.h * H)).toBeCloseTo(before);
    expect(resized.w).toBeCloseTo(0.6);
  });

  it('scales text font size from the corner drag', () => {
    const b = getBounds(text, W, H);
    const resized = resizeAnnotation(text, { x: 0.5, y: text.y + (b.h * 2) / H }, W, H);
    if (resized.type !== 'text') throw new Error();
    expect(resized.fontSize).toBeCloseTo(0.08);
  });
});

describe('rotateAnnotations90', () => {
  // Rotating an image clockwise: pixel (px, py) on a W×H page goes to (H - py, px) on an H×W page
  const toRotatedPx = (x: number, y: number) => ({ x: H - y * H, y: x * W });

  it('maps stroke points so they land on the same image content', () => {
    const [r] = rotateAnnotations90([stroke], W, H);
    if (r.type !== 'stroke') throw new Error();
    const expected = toRotatedPx(0.1, 0.1);
    // New page is H wide, W tall
    expect(r.points[0].x * H).toBeCloseTo(expected.x);
    expect(r.points[0].y * W).toBeCloseTo(expected.y);
    // Pixel width is preserved
    expect(r.width * H).toBeCloseTo(stroke.width * W);
  });

  it('rotates rectangles and arrows', () => {
    const [r, a] = rotateAnnotations90([rect, arrow], W, H);
    if (r.type !== 'rect' || a.type !== 'arrow') throw new Error();
    const bounds = getBounds(r, H, W);
    // Original rect spans px x 200..600, y 600..800 -> rotated x 1200..1400, y 200..600
    expect(bounds.x).toBeCloseTo(1200);
    expect(bounds.y).toBeCloseTo(200);
    expect(bounds.w).toBeCloseTo(200);
    expect(bounds.h).toBeCloseTo(400);
    expect(a.x1 * H).toBeCloseTo(toRotatedPx(0.1, 0.9).x);
    expect(a.y2 * W).toBeCloseTo(toRotatedPx(0.5, 0.9).y);
  });

  it('keeps signatures upright with the same pixel size around the rotated centre', () => {
    const [g] = rotateAnnotations90([sig], W, H);
    if (g.type !== 'signature') throw new Error();
    expect(g.w * H).toBeCloseTo(sig.w * W);
    expect(g.h * W).toBeCloseTo((sig as { h: number }).h * H);
    const c = toRotatedPx(0.75, 0.625);
    expect((g.x + g.w / 2) * H).toBeCloseTo(c.x);
    expect((g.y + g.h / 2) * W).toBeCloseTo(c.y);
  });

  it('returns to the original after four rotations', () => {
    let anns: Annotation[] = [stroke, rect, arrow, sig, text];
    let [w, h] = [W, H];
    for (let i = 0; i < 4; i++) {
      anns = rotateAnnotations90(anns, w, h);
      [w, h] = [h, w];
    }
    const original = [stroke, rect, arrow, sig, text];
    anns.forEach((a, i) => {
      const b1 = getBounds(a, W, H);
      const b2 = getBounds(original[i], W, H);
      expect(b1.x).toBeCloseTo(b2.x);
      expect(b1.y).toBeCloseTo(b2.y);
      expect(b1.w).toBeCloseTo(b2.w);
      expect(b1.h).toBeCloseTo(b2.h);
    });
  });
});
