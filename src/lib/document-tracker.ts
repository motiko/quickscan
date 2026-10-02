import type { Point, Quad } from '@/types';

export interface TrackingState {
  lastCorners: Quad | null;
  stabilityCount: number;
  isStable: boolean;
}

export class DocumentTracker {
  private state: TrackingState = {
    lastCorners: null,
    stabilityCount: 0,
    isStable: false,
  };

  private readonly STABILITY_THRESHOLD = 5; // frames (~600ms at 8fps)
  private readonly MOVEMENT_TOLERANCE = 0.01; // 1% of image size

  /**
   * Applies adaptive Exponential Moving Average (EMA) to smooth coordinates.
   */
  smooth(current: Quad, alpha = 0.6): Quad {
    if (!this.state.lastCorners) {
      this.state.lastCorners = current;
      return current;
    }

    const smoothed: Quad = current.map((p, i) => {
      const last = this.state.lastCorners![i];
      // Adaptive: if distance is huge, snap immediately; otherwise smooth.
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      const actualAlpha = dist > 0.1 ? 1.0 : alpha;

      return {
        x: last.x + actualAlpha * (p.x - last.x),
        y: last.y + actualAlpha * (p.y - last.y),
      };
    });

    this.state.lastCorners = smoothed;
    return smoothed;
  }

  /**
   * Checks if the document has been stable enough to trigger auto-capture.
   */
  updateStability(current: Quad): { isStable: boolean; stability: number } {
    if (!this.state.lastCorners) {
      return { isStable: false, stability: 0 };
    }

    const movement = current.reduce((acc, p, i) => {
      const last = this.state.lastCorners![i];
      return acc + Math.hypot(p.x - last.x, p.y - last.y);
    }, 0) / 4;

    if (movement < this.MOVEMENT_TOLERANCE) {
      this.state.stabilityCount++;
    } else {
      this.state.stabilityCount = 0;
    }

    this.state.isStable = this.state.stabilityCount >= this.STABILITY_THRESHOLD;

    return {
      isStable: this.state.isStable,
      stability: this.state.stabilityCount / this.STABILITY_THRESHOLD,
    };
  }

  reset() {
    this.state = {
      lastCorners: null,
      stabilityCount: 0,
      isStable: false,
    };
  }
}
