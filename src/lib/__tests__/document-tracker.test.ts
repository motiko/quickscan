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

  it('should NOT reach stable with only 14 identical frames', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    let result = { isStable: false, stability: 0 };
    // First call seeds lastRawCorners, 14 more = 15 total calls but only 14 comparisons
    for (let i = 0; i < 15; i++) {
      result = tracker.updateStability(quad);
    }

    // 15 calls = 1 seed + 14 increments => stabilityCount=14, threshold=15
    expect(result.isStable).toBe(false);
    expect(tracker.getStabilityCount()).toBe(14);
    expect(result.stability).toBeLessThan(1);
  });

  it('should reach stable after 15 identical frames', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    let result = { isStable: false, stability: 0 };
    // 1 seed call + 15 comparison calls = 16 total
    for (let i = 0; i < 16; i++) {
      result = tracker.updateStability(quad);
    }

    expect(result.isStable).toBe(true);
    expect(result.stability).toBe(1);
    expect(tracker.getStabilityCount()).toBe(15);
  });

  it('should reset stability on movement', () => {
    const tracker = new DocumentTracker();
    const quad = makeQuad();

    // Feed 10 identical frames (1 seed + 10 comparisons = 11 calls)
    for (let i = 0; i < 11; i++) {
      tracker.updateStability(quad);
    }
    expect(tracker.getStabilityCount()).toBe(10);

    // Move significantly
    const movedQuad = makeQuad(0.05);
    const result = tracker.updateStability(movedQuad);

    expect(result.isStable).toBe(false);
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

    // After reset, stability count should be 0
    expect(tracker.getStabilityCount()).toBe(0);

    // First updateStability after reset should seed and return no stability
    const result = tracker.updateStability(makeQuad());
    expect(result.isStable).toBe(false);
    expect(result.stability).toBe(0);

    // First smooth after reset should return input unchanged
    const smoothResult = tracker.smooth(makeQuad(0.01));
    expect(smoothResult).toEqual(makeQuad(0.01));
  });

  it('stability uses raw corners not smoothed', () => {
    const tracker = new DocumentTracker();
    const base = makeQuad();

    // Feed jittering raw corners with movement ~0.005 per frame.
    // This is below MOVEMENT_TOLERANCE (0.008) per individual frame,
    // BUT the key insight is that raw comparison preserves the actual
    // jitter. We create a deterministic alternating jitter pattern
    // that stays just under tolerance for each frame.
    // With smoothing, these differences would be dampened further,
    // making stability appear falsely high if we compared smoothed values.

    // Use deterministic jitter: alternate +/- 0.004 on each corner
    const sign = [1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1, 1, -1];

    // Seed the raw corners
    tracker.updateStability(base);

    let stableCount = 0;
    for (let i = 0; i < 30; i++) {
      const jitter = sign[i % sign.length] * 0.009; // above 0.008 tolerance
      const jitteredQuad: Quad = base.map((p) => ({
        x: p.x + jitter,
        y: p.y + jitter,
      })) as Quad;

      // Also smooth to show that smoothing would dampen the movement
      tracker.smooth(jitteredQuad);
      const result = tracker.updateStability(jitteredQuad);

      if (result.isStable) stableCount++;
    }

    // With raw comparison and jitter of 0.009 (> 0.008 tolerance),
    // the alternating pattern means each frame moves ~0.018 from the last,
    // so stability should never be reached
    expect(stableCount).toBe(0);
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
