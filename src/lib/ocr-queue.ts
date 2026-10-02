import { db } from '@/lib/db';
import { recognize } from '@/lib/ocr';
import { getSettings } from '@/lib/settings';

type PageOcrListener = (documentId: string, pageNumber: number) => void | Promise<void>;

const listeners = new Set<PageOcrListener>();
let running = false;
let rerunRequested = false;

/** Subscribe to "a page finished OCR" events (used by auto-naming). */
export function onPageOcrDone(listener: PageOcrListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function rebuildSearchText(documentId: string): Promise<void> {
  const pages = await db.pages.where('documentId').equals(documentId).sortBy('pageNumber');
  const searchText = pages
    .map((p) => p.ocrText ?? '')
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
  await db.documents.update(documentId, { searchText });
}

/**
 * OCR every page whose status is 'pending', one at a time.
 * Safe to call repeatedly; concurrent calls coalesce into one extra pass.
 */
export async function processPendingOcr(): Promise<void> {
  if (running) {
    rerunRequested = true;
    return;
  }
  running = true;

  try {
    do {
      rerunRequested = false;
      const settings = await getSettings();
      if (!settings.ocrEnabled) return;

      const pending = await db.pages.where('ocrStatus').equals('pending').toArray();
      for (const page of pending) {
        // Page may have been deleted or changed while earlier pages were processing
        const current = await db.pages.get(page.id);
        if (!current || current.ocrStatus !== 'pending') continue;

        const blob = current.processedBlob || current.originalBlob;
        await db.pages.update(page.id, { ocrStatus: 'processing' });

        try {
          const result = await recognize(blob, settings.ocrLanguages);
          // If the image changed mid-recognition, updatePage reset it to pending; don't overwrite
          const after = await db.pages.get(page.id);
          if (!after || after.ocrStatus !== 'processing') continue;

          const { detectOcrLanguage } = await import('@/lib/language-detect');
          await db.pages.update(page.id, {
            ocrStatus: 'done',
            ocrText: result.text,
            ocrWords: result.words,
            ocrLang: settings.ocrLanguages.join('+'),
            ocrInfo: {
              engine: 'tesseract',
              languages: [...settings.ocrLanguages],
              detectedLanguage: detectOcrLanguage(result.text),
              confidence: Math.round(result.confidence),
              recognizedAt: new Date(),
            },
          });
          await rebuildSearchText(page.documentId);

          for (const listener of listeners) {
            try {
              await listener(page.documentId, after.pageNumber);
            } catch (err) {
              console.warn('OCR listener failed:', err);
            }
          }
        } catch (err) {
          console.warn('OCR failed for page', page.id, err);
          await db.pages.update(page.id, { ocrStatus: 'error' });
        }
      }
    } while (rerunRequested);
  } finally {
    running = false;
  }
}

/** Pages left 'processing' by a closed tab will never finish; put them back in the queue. */
export async function resetStaleOcr(): Promise<void> {
  if (running) return;
  await db.pages.where('ocrStatus').equals('processing').modify({ ocrStatus: 'pending' });
}

export async function retryOcr(pageId: string): Promise<void> {
  await db.pages.update(pageId, { ocrStatus: 'pending' });
  await processPendingOcr();
}

/** Re-run OCR on every page of one document. */
export async function retryDocumentOcr(documentId: string): Promise<void> {
  await db.pages.where('documentId').equals(documentId).modify({ ocrStatus: 'pending' });
  await processPendingOcr();
}

/** Re-queue every page, e.g. after the OCR language changes. */
export async function requeueAllOcr(): Promise<void> {
  await db.pages.toCollection().modify({ ocrStatus: 'pending' });
  await processPendingOcr();
}
