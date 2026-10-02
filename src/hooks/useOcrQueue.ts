'use client';

import { useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { processPendingOcr, resetStaleOcr } from '@/lib/ocr-queue';
import { useSettings } from '@/hooks/useSettings';

/** Runs background OCR whenever there are pending pages and OCR is enabled. */
export function useOcrQueue() {
  const pendingCount = useLiveQuery(
    () => db.pages.where('ocrStatus').equals('pending').count(),
    []
  );
  const { settings } = useSettings();

  useEffect(() => {
    void resetStaleOcr();
  }, []);

  useEffect(() => {
    if (settings.ocrEnabled && pendingCount && pendingCount > 0) {
      void processPendingOcr();
    }
  }, [pendingCount, settings.ocrEnabled]);
}
