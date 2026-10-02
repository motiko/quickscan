'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import type { Quad, DetectedQuad } from '@/types';

export interface DetectionResult extends DetectedQuad {
  normalizedCorners: Quad | null;
}

export function useScannerWorker() {
  const workerRef = useRef<Worker | null>(null);
  const [isReady, setIsReady] = useState(false);
  const pendingRequests = useRef<Map<number, (res: DetectionResult) => void>>(new Map());
  const nextReqId = useRef(1);

  useEffect(() => {
    try {
      const worker = new Worker(new URL('../lib/scanner.worker.ts', import.meta.url), {
        type: 'module',
      });

      worker.onmessage = (e: MessageEvent) => {
        const { id, type, normalizedCorners, confidence, isStable, stability, corners } = e.data;
        if (type === 'DETECTED') {
          const resolve = pendingRequests.current.get(id);
          if (resolve) {
            pendingRequests.current.delete(id);
            resolve({ normalizedCorners, confidence, isStable, stability, corners });
          }
        }
      };

      worker.onerror = (err) => {
        console.warn('Scanner worker error:', err);
      };

      workerRef.current = worker;
      // Mark ready asynchronously
      const readyTimer = setTimeout(() => setIsReady(true), 50);

      const requests = pendingRequests.current;

      return () => {
        clearTimeout(readyTimer);
        worker.terminate();
        workerRef.current = null;
        requests.clear();
      };
    } catch (err) {
      console.warn('Could not initialize scanner worker:', err);
    }
  }, []);

  const detect = useCallback(
    async (
      imageData: ImageData,
      options?: { detector?: 'classical' | 'ml' }
    ): Promise<DetectionResult> => {
      const worker = workerRef.current;
      if (!worker) {
        return { normalizedCorners: null, confidence: 0, isStable: false, stability: 0, corners: null };
      }

      const reqId = nextReqId.current++;
      return new Promise<DetectionResult>((resolve) => {
        pendingRequests.current.set(reqId, resolve);
        worker.postMessage({
          id: reqId,
          type: 'DETECT',
          imageData,
          detector: options?.detector || 'classical',
        });

        // Safety timeout in case worker drops frame
        setTimeout(() => {
          if (pendingRequests.current.has(reqId)) {
            pendingRequests.current.delete(reqId);
            resolve({ normalizedCorners: null, confidence: 0, isStable: false, stability: 0, corners: null });
          }
        }, 1500);
      });
    },
    []
  );

  return { isReady, detect };
}
