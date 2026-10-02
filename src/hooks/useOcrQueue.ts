'use client';

import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { processPendingOcr, resetStaleOcr } from '@/lib/ocr-queue';

/** Runs background OCR whenever there are pending pages. */
export function useOcrQueue() {
  const pendingCount = useLiveQuery(
    () => db.pages.where('ocrStatus').equals('pending').count(),
    []
  );

  useEffect(() => {
    void resetStaleOcr();
  }, []);

  useEffect(() => {
    if (pendingCount && pendingCount > 0) {
      void processPendingOcr();
    }
  }, [pendingCount]);
}
