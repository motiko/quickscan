import type { Quad } from '@/types';

export interface TrackingState {
  lastSmoothedCorners: Quad | null; // for EMA output (visual overlay)
  lastRawCorners: Quad | null; // for stability comparison (unsmoothed input)
  stabilityCount: number;
  isStable: boolean;
}

export class DocumentTracker {
  private state: TrackingState = {
    lastSmoothedCorners: null,
    lastRawCorners: null,
    stabilityCount: 0,
    isStable: false,
  };

  private readonly STABILITY_THRESHOLD = 15; // frames (~1.8s at 8fps)
  private readonly MOVEMENT_TOLERANCE = 0.008; // 0.8% of image size

  /**
   * Applies adaptive Exponential Moving Average (EMA) to smooth coordinates.
   * Uses `lastSmoothedCorners` for blending. Large jumps (>0.1) snap immediately.
   */
  smooth(current: Quad, alpha = 0.45): Quad {
    if (!this.state.lastSmoothedCorners) {
      this.state.lastSmoothedCorners = current;
      return current;
    }

    const smoothed: Quad = current.map((p, i) => {
      const last = this.state.lastSmoothedCorners![i];
      // Adaptive: if distance is huge, snap immediately; otherwise smooth.
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const actualAlpha = dist > 0.1 ? 1.0 : alpha;

      return {
        x: last.x + actualAlpha * (p.x - last.x),
        y: last.y + actualAlpha * (p.y - last.y),
      };
    }) as Quad;

    this.state.lastSmoothedCorners = smoothed;
    return smoothed;
  }

  /**
   * Checks if the document has been stable enough to trigger auto-capture.
   * Compares raw (unsmoothed) corners to avoid the self-comparison bug where
   * smoothed-vs-smoothed comparison made movement look artificially small.
   */
  updateStability(rawCorners: Quad): { isStable: boolean; stability: number } {
    if (!this.state.lastRawCorners) {
      this.state.lastRawCorners = rawCorners;
      return { isStable: false, stability: 0 };
    }

    const movement =
      rawCorners.reduce((acc, p, i) => {
        const last = this.state.lastRawCorners![i];
        return acc + Math.hypot(p.x - last.x, p.y - last.y);
      }, 0) / 4;

    this.state.lastRawCorners = rawCorners;

    if (movement < this.MOVEMENT_TOLERANCE) {
      this.state.stabilityCount++;
    } else {
      this.state.stabilityCount = 0;
    }

    this.state.isStable =
      this.state.stabilityCount >= this.STABILITY_THRESHOLD;

    return {
      isStable: this.state.isStable,
      stability: Math.min(1, this.state.stabilityCount / this.STABILITY_THRESHOLD),
    };
  }

  /** Resets all tracking state to initial values. */
  reset(): void {
    this.state = {
      lastSmoothedCorners: null,
      lastRawCorners: null,
      stabilityCount: 0,
      isStable: false,
    };
  }

  /** Returns the current stability frame count (useful for testing). */
  getStabilityCount(): number {
    return this.state.stabilityCount;
  }
}
