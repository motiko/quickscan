import { describe, it, expect } from 'vitest';
import type { Quad } from '@/types';
import { DocumentTracker } from '../document-tracker';

/** Creates a standard test quad with optional uniform offset. */
function makeQuad(offset = 0): Quad {
  return [
    { x: 0.2 + offset, y: 0.2 + offset },
    { x: 0.8 + offset, y: 0.2 + offset },
    { x: 0.8 + offset, y: 0.8 + offset },
    { x: 0.2 + offset, y: 0.8 + offset },
  ];
}

describe('DocumentTracker', () => {
  it('should start with no stability', () => {
    const tracker = new DocumentTracker();
    const result = tracker.updateStability(makeQuad());

    expect(result.isStable).toBe(false);
    expect(result.stability).toBe(0);
  });

  it('smooth should return input on first call', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();
    const result = tracker.smooth(quad);

    expect(result).toEqual(quad);
  });

  it('smooth should apply EMA on subsequent calls', () => {
    const tracker = new DocumentTracker();
    const first = makeQuad(0);
    const second = makeQuad(0.05);

    tracker.smooth(first);
    const result = tracker.smooth(second);

    // With alpha=0.45, result should be between first and second
    for (let i = 0; i < 4; i++) {
      expect(result[i].x).toBeGreaterThan(first[i].x);
      expect(result[i].x).toBeLessThan(second[i].x);
      // Verify exact EMA: last + alpha * (current - last)
      const expectedX = first[i].x + 0.45 * (second[i].x - first[i].x);
      expect(result[i].x).toBeCloseTo(expectedX, 10);
    }
  });

  it('should NOT reach stable with only 9 identical frames', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    let result = { isStable: false, stability: 0 };
    // 1 seed call + 9 comparisons
    for (let i = 0; i < 10; i++) {
      result = tracker.updateStability(quad);
    }

    expect(result.isStable).toBe(false);
    expect(tracker.getStabilityCount()).toBe(9);
    expect(result.stability).toBeLessThan(1);
  });

  it('should reach stable after 10 identical frames', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    let result = { isStable: false, stability: 0 };
    // 1 seed call + 10 comparison calls = 11 total
    for (let i = 0; i < 11; i++) {
      result = tracker.updateStability(quad);
    }

    expect(result.isStable).toBe(true);
    expect(result.stability).toBe(1);
    expect(tracker.getStabilityCount()).toBe(10);
  });

  it('should tolerate small detector jitter around a fixed position', () => {
    const tracker = new DocumentTracker();
    const base = makeQuad();
    tracker.updateStability(base);

    // Alternating ±0.008 per axis ≈ 0.011 from the anchor — typical 2–3px
    // jitter at 320px detection width. Frame-to-frame this moves ~0.023,
    // which used to reset stability every frame.
    let result = { isStable: false, stability: 0 };
    for (let i = 0; i < 10; i++) {
      const j = (i % 2 === 0 ? 1 : -1) * 0.008;
      result = tracker.updateStability(base.map((p) => ({ x: p.x + j, y: p.y + j })) as Quad);
    }

    expect(result.isStable).toBe(true);
  });

  it('should ignore a single outlier frame without losing progress', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();
    for (let i = 0; i < 6; i++) tracker.updateStability(quad);
    expect(tracker.getStabilityCount()).toBe(5);

    tracker.updateStability(makeQuad(0.05)); // one bad detection
    expect(tracker.getStabilityCount()).toBe(5);

    tracker.updateStability(quad);
    expect(tracker.getStabilityCount()).toBe(6);
  });

  it('should reset stability on sustained movement', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    for (let i = 0; i < 11; i++) {
      tracker.updateStability(quad);
    }
    expect(tracker.getStabilityCount()).toBe(10);

    const movedQuad = makeQuad(0.05);
    tracker.updateStability(movedQuad);
    const result = tracker.updateStability(movedQuad);

    expect(result.isStable).toBe(false);
    expect(tracker.getStabilityCount()).toBe(0);
  });

  it('should reset on slow drift beyond tolerance', () => {
    const tracker = new DocumentTracker();
    tracker.updateStability(makeQuad());

    // 0.003/frame drift: tiny frame-to-frame, but accumulates past the anchor tolerance
    let maxCount = 0;
    for (let i = 1; i <= 30; i++) {
      tracker.updateStability(makeQuad(i * 0.003));
      maxCount = Math.max(maxCount, tracker.getStabilityCount());
    }
    expect(maxCount).toBeLessThan(10);
  });

  it('should hold corners through a brief detection dropout', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();
    tracker.smooth(quad);
    for (let i = 0; i < 6; i++) tracker.updateStability(quad);

    expect(tracker.registerMiss()).toEqual(quad);
    expect(tracker.registerMiss()).toEqual(quad);
    expect(tracker.getStabilityCount()).toBe(5);

    // Third consecutive miss resets tracking
    expect(tracker.registerMiss()).toBeNull();
    expect(tracker.getStabilityCount()).toBe(0);
  });

  it('should reset all state on reset()', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    // Build up some state
    tracker.smooth(quad);
    for (let i = 0; i < 11; i++) {
      tracker.updateStability(quad);
    }
    expect(tracker.getStabilityCount()).toBe(10);

    tracker.reset();

    expect(tracker.getStabilityCount()).toBe(0);

    // First updateStability after reset should seed and return no stability
    const result = tracker.updateStability(makeQuad());
    expect(result.isStable).toBe(false);
    expect(result.stability).toBe(0);

    // First smooth after reset should return input unchanged
    const smoothResult = tracker.smooth(makeQuad(0.01));
    expect(smoothResult).toEqual(makeQuad(0.01));
  });

  it('large jump should snap smoothing', () => {
    const tracker = new DocumentTracker();
    const first = makeQuad(0);
    tracker.smooth(first);

    // Jump > 0.1 per corner — should snap to new position
    const jumped = makeQuad(0.2);
    const result = tracker.smooth(jumped);

    // With snap (alpha=1.0), the result should equal the jumped quad
    for (let i = 0; i < 4; i++) {
      expect(result[i].x).toBeCloseTo(jumped[i].x, 10);
      expect(result[i].y).toBeCloseTo(jumped[i].y, 10);
    }
  });
});
