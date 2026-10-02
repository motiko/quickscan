'use client';

import { useEffect } from 'react';
import { useOcrQueue } from '@/hooks/useOcrQueue';
import { onPageOcrDone } from '@/lib/ocr-queue';
import { autoNameIfDefault } from '@/lib/naming';

export function OcrRunner() {
  useOcrQueue();

  useEffect(() => onPageOcrDone((documentId) => autoNameIfDefault(documentId)), []);

  return null;
}
