'use client';

import { useOcrQueue } from '@/hooks/useOcrQueue';

export function OcrRunner() {
  useOcrQueue();
  return null;
}
