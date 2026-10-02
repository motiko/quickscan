import type { Quad } from '@/types';
import { detectDocumentQuadAsync } from './scanner';

// Web Worker message listener
self.onmessage = async (e: MessageEvent) => {
  const { id, type, imageData, detector = 'classical' } = e.data;

  if (type === 'DETECT') {
    try {
      const result = await detectDocumentQuadAsync(imageData, { detector });
      if (result) {
        const W = imageData.width;
        const H = imageData.height;

        const normalizedCorners: Quad = [
          { x: result.corners[0].x / W, y: result.corners[0].y / H },
          { x: result.corners[1].x / W, y: result.corners[1].y / H },
          { x: result.corners[2].x / W, y: result.corners[2].y / H },
          { x: result.corners[3].x / W, y: result.corners[3].y / H },
        ];

        self.postMessage({
          id,
          type: 'DETECTED',
          corners: result.corners,
          normalizedCorners,
          confidence: result.confidence,
        });
      } else {
        self.postMessage({
          id,
          type: 'DETECTED',
          corners: null,
          normalizedCorners: null,
          confidence: 0,
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
      });
    }
  }
};

export {};
