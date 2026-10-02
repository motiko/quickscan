import type { Quad } from '@/types';
import { detectDocumentQuadAsync } from './scanner';
import { MLCornerDetector } from './ml-detector';
import { DocumentTracker } from './document-tracker';

const mlDetector = new MLCornerDetector();
const tracker = new DocumentTracker();
let isMLInitialized = false;

// Web Worker message listener
self.onmessage = async (e: MessageEvent) => {
  const { id, type, imageData, detector = 'classical' } = e.data;

  if (type === 'DETECT') {
    try {
      if (detector === 'ml' && !isMLInitialized) {
        await mlDetector.init();
        isMLInitialized = true;
      }

      const result = await detectDocumentQuadAsync(imageData, { detector });
      if (result && result.corners) {
        const W = imageData.width;
        const H = imageData.height;

        const rawNormalizedCorners: Quad = [
          { x: result.corners[0].x / W, y: result.corners[0].y / H },
          { x: result.corners[1].x / W, y: result.corners[1].y / H },
          { x: result.corners[2].x / W, y: result.corners[2].y / H },
          { x: result.corners[3].x / W, y: result.corners[3].y / H },
        ];

        // Apply temporal smoothing and check stability
        const smoothedCorners = tracker.smooth(rawNormalizedCorners);
        const { isStable, stability } = tracker.updateStability(smoothedCorners);

        self.postMessage({
          id,
          type: 'DETECTED',
          corners: result.corners,
          normalizedCorners: smoothedCorners,
          confidence: result.confidence,
          isStable,
          stability,
        });

        if (isStable && result.confidence > 0.8) {
          self.postMessage({
            id,
            type: 'CAPTURE_TRIGGER',
            corners: result.corners,
          });
        }
      } else {
        tracker.reset();
        self.postMessage({
          id,
          type: 'DETECTED',
          corners: null,
          normalizedCorners: null,
          confidence: 0,
          isStable: false,
          stability: 0,
        });
      }
    } catch (err) {
      console.warn('Worker detection failed:', err);
      self.postMessage({
        id,
        type: 'DETECTED',
        corners: null,
        normalizedCorners: null,
        confidence: 0,
        isStable: false,
        stability: 0,
      });
    }
  }
};

export {};
