import type { Quad, DetectionHint } from '@/types';
import { detectDocumentQuadAsync } from './scanner';
import { analyzeFrame } from './frame-analyzer';
import { MLCornerDetector } from './ml-detector';
import { DocumentTracker } from './document-tracker';

const mlDetector = new MLCornerDetector();
const tracker = new DocumentTracker();
let isMLInitialized = false;
let lastConfidence = 0;

// Web Worker message listener
self.onmessage = async (e: MessageEvent) => {
  const { id, type, imageData, detector = 'classical', track = true } = e.data;

  if (type === 'DETECT') {
    try {
      if (detector === 'ml' && !isMLInitialized) {
        await mlDetector.init();
        isMLInitialized = true;
      }

      // Analyze frame for environmental quality (brightness, contrast)
      const frameAnalysis = analyzeFrame(imageData);

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

        // One-shot detection (e.g. still image in the crop screen): skip tracking
        if (!track) {
          self.postMessage({
            id,
            type: 'DETECTED',
            corners: result.corners,
            normalizedCorners: rawNormalizedCorners,
            confidence: result.confidence,
            isStable: false,
            stability: 0,
            hint: null,
            frameAnalysis,
          });
          return;
        }

        // Apply temporal smoothing for visual overlay
        const smoothedCorners = tracker.smooth(rawNormalizedCorners);
        // Check stability using RAW corners (not smoothed) to detect real movement
        const { isStable, stability } = tracker.updateStability(rawNormalizedCorners);

        // Determine document-level hint based on detection + stability state
        let hint: DetectionHint = frameAnalysis.hint;
        if (!hint) {
          // No environment issue — show document-level guidance
          const area = computeNormalizedArea(rawNormalizedCorners);
          if (area < 0.18) {
            hint = 'move_closer';
          } else if (area > 0.88) {
            hint = 'move_further';
          } else if (!isStable) {
            hint = 'hold_steady';
          } else {
            hint = null; // Ready — no hint needed
          }
        }

        lastConfidence = result.confidence;
        self.postMessage({
          id,
          type: 'DETECTED',
          corners: result.corners,
          normalizedCorners: smoothedCorners,
          confidence: result.confidence,
          isStable,
          stability,
          hint,
          frameAnalysis,
        });
      } else {
        // Hold the last quad through a brief detection dropout so one missed
        // frame does not wipe out stability progress.
        const held = track ? tracker.registerMiss() : null;
        if (held) {
          const { isStable, stability } = tracker.getStability();
          self.postMessage({
            id,
            type: 'DETECTED',
            corners: null,
            normalizedCorners: held,
            confidence: lastConfidence,
            isStable,
            stability,
            hint: frameAnalysis.hint ?? (isStable ? null : 'hold_steady'),
            frameAnalysis,
          });
          return;
        }

        // Even with no document detected, report environment hints
        const hint: DetectionHint = frameAnalysis.hint ?? 'align_document';

        self.postMessage({
          id,
          type: 'DETECTED',
          corners: null,
          normalizedCorners: null,
          confidence: 0,
          isStable: false,
          stability: 0,
          hint,
          frameAnalysis,
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
        hint: null,
        frameAnalysis: null,
      });
    }
  }
};

/**
 * Compute area of a normalized quad (corners in 0..1 range).
 * Uses the shoelace formula.
 */
function computeNormalizedArea(quad: Quad): number {
  let area = 0;
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    area += quad[i].x * quad[j].y;
    area -= quad[j].x * quad[i].y;
  }
  return Math.abs(area) / 2;
}

export {};
