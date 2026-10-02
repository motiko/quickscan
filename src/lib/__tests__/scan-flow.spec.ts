/**
 * Scan-flow integration test harness.
 *
 * Simulates the full detection → tracking → stability → capture pipeline
 * by feeding pre-generated synthetic frames through `detectDocumentQuad`
 * and `DocumentTracker`, exactly as the scanner worker does.
 *
 * To test with real footage, extract frames with:
 *   ffmpeg -i input.mp4 -vf "fps=8,scale=320:-1" fixtures/%04d.png
 * Then load them via loadPngFrames() below.
 */
import { describe, it, expect } from 'vitest';
import { detectDocumentQuad } from '../scanner';
import { DocumentTracker } from '../document-tracker';
import { analyzeFrame } from '../frame-analyzer';
import type { Quad } from '@/types';

// ---------------------------------------------------------------------------
// Helpers: synthetic frame generation
// ---------------------------------------------------------------------------

function createImageData(width: number, height: number): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  return { data, width, height, colorSpace: 'srgb' } as ImageData;
}

function fillRect(
  img: ImageData,
  x: number, y: number, w: number, h: number,
  r: number, g: number, b: number
) {
  for (let py = y; py < Math.min(y + h, img.height); py++) {
    for (let px = x; px < Math.min(x + w, img.width); px++) {
      const idx = (py * img.width + px) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
}

/**
 * Creates a synthetic frame with a white document rectangle on a dark background.
 * The document can be shifted by dx/dy to simulate camera movement.
 */
function createDocumentFrame(
  width: number,
  height: number,
  docX: number,
  docY: number,
  docW: number,
  docH: number,
  bgBrightness = 40
): ImageData {
  const img = createImageData(width, height);
  fillRect(img, 0, 0, width, height, bgBrightness, bgBrightness, bgBrightness);
  fillRect(img, docX, docY, docW, docH, 240, 240, 240);
  return img;
}

/**
 * Creates a uniform frame with no document (just background noise).
 */
function createEmptyFrame(width: number, height: number, brightness = 100): ImageData {
  const img = createImageData(width, height);
  fillRect(img, 0, 0, width, height, brightness, brightness, brightness);
  return img;
}

/**
 * Normalizes pixel-space corners to 0..1 range.
 */
function normalizeCorners(corners: Quad, width: number, height: number): Quad {
  return corners.map((p) => ({
    x: p.x / width,
    y: p.y / height,
  })) as Quad;
}

// ---------------------------------------------------------------------------
// Pipeline simulation
// ---------------------------------------------------------------------------

interface PipelineResult {
  totalFrames: number;
  detectedFrames: number;
  captureTriggeredAtFrame: number | null;
  maxStability: number;
  maxConfidence: number;
  hints: (string | null)[];
}

/**
 * Runs the full pipeline over a sequence of ImageData frames,
 * matching the logic in scanner.worker.ts + CameraView.tsx.
 */
function runPipeline(
  frames: ImageData[],
  opts: {
    minCaptureConfidence?: number;
    stabilityThreshold?: number;
  } = {}
): PipelineResult {
  const { minCaptureConfidence = 0.65 } = opts;

  const tracker = new DocumentTracker();
  let captureTriggeredAtFrame: number | null = null;
  let maxStability = 0;
  let maxConfidence = 0;
  let detectedFrames = 0;
  const hints: (string | null)[] = [];

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    const analysis = analyzeFrame(frame);
    const result = detectDocumentQuad(frame);

    if (result && result.corners) {
      detectedFrames++;
      const rawNorm = normalizeCorners(result.corners, frame.width, frame.height);
      tracker.smooth(rawNorm);
      const { isStable, stability } = tracker.updateStability(rawNorm);

      maxStability = Math.max(maxStability, stability);
      maxConfidence = Math.max(maxConfidence, result.confidence);

      if (isStable && result.confidence >= minCaptureConfidence && captureTriggeredAtFrame === null) {
        captureTriggeredAtFrame = i;
      }

      hints.push(analysis.hint);
    } else {
      tracker.reset();
      hints.push(analysis.hint ?? 'align_document');
    }
  }

  return {
    totalFrames: frames.length,
    detectedFrames,
    captureTriggeredAtFrame,
    maxStability,
    maxConfidence,
    hints,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Scan flow simulation', () => {
  describe('No-document scenes', () => {
    it('should NOT trigger capture on uniform gray frames', () => {
      // 40 frames of uniform gray = 5 seconds at 8fps
      const frames = Array.from({ length: 40 }, () =>
        createEmptyFrame(320, 240, 128)
      );

      const result = runPipeline(frames);

      expect(result.captureTriggeredAtFrame).toBeNull();
      expect(result.detectedFrames).toBe(0);
    });

    it('should NOT trigger capture on dark scene (too dark hint)', () => {
      const frames = Array.from({ length: 30 }, () =>
        createEmptyFrame(320, 240, 20)
      );

      const result = runPipeline(frames);

      expect(result.captureTriggeredAtFrame).toBeNull();
      // Should produce "too_dark" hints
      expect(result.hints.filter((h) => h === 'too_dark').length).toBeGreaterThan(0);
    });
  });

  describe('Steady document', () => {
    it('should eventually trigger capture on a steady well-positioned document', () => {
      // Document covers ~36% of frame (good range), held perfectly still
      const frames = Array.from({ length: 40 }, () =>
        createDocumentFrame(320, 240, 60, 40, 200, 160)
      );

      const result = runPipeline(frames);

      expect(result.captureTriggeredAtFrame).not.toBeNull();
      expect(result.maxConfidence).toBeGreaterThan(0.5);
      // Capture should NOT happen in the first few frames
      expect(result.captureTriggeredAtFrame!).toBeGreaterThanOrEqual(14);
    });

    it('should NOT trigger capture in fewer than 15 frames even when stable', () => {
      // Only 14 frames — not enough for stability threshold
      const frames = Array.from({ length: 14 }, () =>
        createDocumentFrame(320, 240, 60, 40, 200, 160)
      );

      const result = runPipeline(frames);

      // Stability threshold is 15, so 14 frames should not be enough
      // (first frame initializes, then 13 stable frames < 15 threshold)
      expect(result.captureTriggeredAtFrame).toBeNull();
    });
  });

  describe('Moving camera', () => {
    it('should NOT trigger capture when camera is constantly moving', () => {
      // Document shifts by 3px each frame — simulates hand jitter
      const frames = Array.from({ length: 40 }, (_, i) =>
        createDocumentFrame(320, 240, 60 + (i % 6) * 3, 40, 200, 160)
      );

      const result = runPipeline(frames);

      expect(result.captureTriggeredAtFrame).toBeNull();
    });

    it('should trigger capture after camera stabilizes', () => {
      // 20 frames of movement, then 25 frames of stillness
      const frames: ImageData[] = [];

      // Moving phase — 5px/frame shift is well above stability tolerance
      // (5/320 = 0.0156 normalized, vs 0.008 tolerance)
      for (let i = 0; i < 20; i++) {
        frames.push(createDocumentFrame(320, 240, 60 + i * 5, 40, 180, 140));
      }

      // Stable phase — document held perfectly still
      for (let i = 0; i < 25; i++) {
        frames.push(createDocumentFrame(320, 240, 60, 40, 180, 140));
      }

      const result = runPipeline(frames);

      expect(result.captureTriggeredAtFrame).not.toBeNull();
      // Capture should happen during the stable phase (after frame 20),
      // plus ~16 frames for stability threshold + tracker init
      expect(result.captureTriggeredAtFrame!).toBeGreaterThanOrEqual(20);
    });
  });

  describe('Small / too-large documents', () => {
    it('should have low confidence for very small document (<15% area)', () => {
      // 20x16 on a 320x240 canvas = ~1% area
      const frames = Array.from({ length: 30 }, () =>
        createDocumentFrame(320, 240, 150, 112, 20, 16)
      );

      const result = runPipeline(frames);

      // May or may not detect edges, but should not trigger auto-capture
      expect(result.captureTriggeredAtFrame).toBeNull();
    });
  });

  describe('Frame analysis integration', () => {
    it('should produce too_dark hints for dark frames', () => {
      const frames = Array.from({ length: 5 }, () =>
        createEmptyFrame(320, 240, 20)
      );

      const result = runPipeline(frames);
      expect(result.hints.every((h) => h === 'too_dark' || h === 'align_document')).toBe(true);
    });

    it('should produce no environment hints for well-lit scenes', () => {
      const frames = Array.from({ length: 5 }, () =>
        createDocumentFrame(320, 240, 60, 40, 200, 160)
      );

      const result = runPipeline(frames);
      // Hints should be null (no issue) or hold_steady/align_document
      const envHints = result.hints.filter(
        (h) => h === 'too_dark' || h === 'too_bright' || h === 'low_contrast'
      );
      expect(envHints.length).toBe(0);
    });
  });
});
