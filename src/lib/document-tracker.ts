import type { Quad } from '@/types';

export interface TrackingState {
  lastSmoothedCorners: Quad | null; // for EMA output (visual overlay)
  anchorCorners: Quad | null; // raw corners at the start of the current stable streak
  stabilityCount: number;
  outlierCount: number; // consecutive frames that deviated from the anchor
  missCount: number; // consecutive frames with no detection
  isStable: boolean;
}

export class DocumentTracker {
  private state: TrackingState = DocumentTracker.initialState();

  private readonly STABILITY_THRESHOLD = 10; // frames (~1.2s at 8fps)
  /**
   * Max mean corner deviation from the anchor (normalized units) that still
   * counts as "holding still". Comparing against a fixed anchor instead of the
   * previous frame tolerates detector jitter of a few pixels while still
   * catching slow drift.
   */
  private readonly MOVEMENT_TOLERANCE = 0.02;
  /** Consecutive outlier frames tolerated before the streak resets. */
  private readonly MAX_OUTLIERS = 1;
  /** Consecutive missed detections tolerated before tracking resets. */
  private readonly MAX_MISSES = 2;

  private static initialState(): TrackingState {
    return {
      lastSmoothedCorners: null,
      anchorCorners: null,
      stabilityCount: 0,
      outlierCount: 0,
      missCount: 0,
      isStable: false,
    };
  }

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
   * Raw (unsmoothed) corners are compared against the anchor captured when the
   * current streak began. A single outlier frame is ignored; sustained
   * deviation re-anchors and restarts the streak.
   */
  updateStability(rawCorners: Quad): { isStable: boolean; stability: number } {
    this.state.missCount = 0;

    if (!this.state.anchorCorners) {
      this.state.anchorCorners = rawCorners;
      return { isStable: false, stability: 0 };
    }

    const deviation =
      rawCorners.reduce((acc, p, i) => {
        const anchor = this.state.anchorCorners![i];
        return acc + Math.hypot(p.x - anchor.x, p.y - anchor.y);
      }, 0) / 4;

    if (deviation < this.MOVEMENT_TOLERANCE) {
      this.state.outlierCount = 0;
      this.state.stabilityCount++;
    } else if (this.state.outlierCount < this.MAX_OUTLIERS) {
      // Tolerate a single bad frame without losing progress
      this.state.outlierCount++;
    } else {
      this.state.anchorCorners = rawCorners;
      this.state.outlierCount = 0;
      this.state.stabilityCount = 0;
    }

    this.state.isStable =
      this.state.stabilityCount >= this.STABILITY_THRESHOLD;

    return this.getStability();
  }

  /**
   * Records a frame where no document was found. Returns the last smoothed
   * corners while within the miss budget (so a single dropped detection does
   * not wipe progress), or null once tracking has been reset.
   */
  registerMiss(): Quad | null {
    this.state.missCount++;
    if (this.state.missCount > this.MAX_MISSES || !this.state.lastSmoothedCorners) {
      this.reset();
      return null;
    }
    return this.state.lastSmoothedCorners;
  }

  /** Current stability without feeding a new frame. */
  getStability(): { isStable: boolean; stability: number } {
    return {
      isStable: this.state.isStable,
      stability: Math.min(1, this.state.stabilityCount / this.STABILITY_THRESHOLD),
    };
  }

  /** Resets all tracking state to initial values. */
  reset(): void {
    this.state = DocumentTracker.initialState();
  }

  /** Returns the current stability frame count (useful for testing). */
  getStabilityCount(): number {
    return this.state.stabilityCount;
  }
}
