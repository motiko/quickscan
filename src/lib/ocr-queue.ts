import { db } from '@/lib/db';
import type { OcrResult } from '@/lib/ocr';
import { ocrProviderFor, tesseractOcr, type OcrProvider } from '@/lib/platform/ocr';
import { getSettings } from '@/lib/settings';
import { pageImage } from '@/lib/page-image';
import { recognizeUpright, uprightFromEngine, type Rotation, type UprightResult } from '@/lib/ocr-orientation';
import { createThumbnail, fitImage, rotateImage } from '@/lib/image-processing';
import { getImageSize, getRenderedBlob } from '@/lib/annotations/flatten';
import { rotateAnnotations90 } from '@/lib/annotations/geometry';
import type { Annotation, Page } from '@/types';

type PageOcrListener = (documentId: string, pageNumber: number) => void | Promise<void>;

const listeners = new Set<PageOcrListener>();
let running = false;
let rerunRequested = false;

/**
 * Call when the user rotates a page, so OCR doesn't turn it back. Remembered on the page
 * (`keepOrientation`, local only), so it holds after a reload too; `updatePage` sets it as
 * well whenever the image changes by hand.
 */
export async function keepPageOrientation(pageId: string): Promise<void> {
  try {
    await db.pages.update(pageId, { keepOrientation: true });
  } catch (err) {
    console.warn('Could not remember the page orientation:', err);
  }
}

/**
 * Auto-orientation only runs on a page's first recognition, of the image this device
 * captured (it has the original): never on a pulled page or an image downloaded from another
 * device, a page turned by hand, a retry or a re-run (all marked `keepOrientation`), where
 * turning the image would be an edit the user didn't make.
 */
function mayAutoOrient(page: Page): boolean {
  return page.originalBlob != null && !page.keepOrientation && page.ocrInfo === undefined && page.ocrText === undefined;
}

/**
 * Longest side of the image Tesseract gets. Recognition doesn't improve past ~250 dpi (an A4
 * page at this size), while a full 8–12 MP image inside the OCR worker, plus the rotated copies
 * the orientation probes make of it, pushes iOS Safari past its memory limit and kills the
 * page right after a scan is saved. A cropped 4K capture already fits; larger images (imports,
 * uncropped frames) are scaled down for recognition only, and the word boxes are mapped back.
 */
const OCR_MAX_DIMENSION = 2500;

/**
 * Recognize the OCR copy with the page's engine, upright when `autoOrient`. Vision reads text
 * in any orientation and reports which way the page is turned; Tesseract needs the probe, as
 * its confidence drops on text the wrong way round. A native failure falls back to Tesseract.
 */
async function recognizeWith(
  provider: OcrProvider,
  image: Blob,
  langs: string[],
  autoOrient: boolean
): Promise<{ recognized: UprightResult; engine: OcrProvider['engine'] }> {
  if (provider !== tesseractOcr) {
    try {
      const result = await provider.recognize(image, langs);
      return { recognized: autoOrient ? uprightFromEngine(result) : { result, rotation: 0 }, engine: provider.engine };
    } catch (err) {
      console.warn(`${provider.engine} OCR failed; using Tesseract:`, err);
    }
  }
  const recognize = (b: Blob) => tesseractOcr.recognize(b, langs);
  const recognized = autoOrient
    ? await recognizeUpright(image, recognize, rotateImage)
    : { result: await recognize(image), rotation: 0 as const };
  return { recognized, engine: 'tesseract' };
}

/** Word boxes measured on the OCR copy, in the page image's pixels. */
function scaleToPage(upright: UprightResult, scale: number): UprightResult {
  if (scale === 1) return upright;
  const toPage = (r: OcrResult): OcrResult => ({
    ...r,
    words: r.words.map((w) => ({
      ...w,
      bbox: {
        x0: Math.round(w.bbox.x0 / scale),
        y0: Math.round(w.bbox.y0 / scale),
        x1: Math.round(w.bbox.x1 / scale),
        y1: Math.round(w.bbox.y1 / scale),
      },
    })),
  });
  return { ...upright, result: toPage(upright.result), unrotated: upright.unrotated && toPage(upright.unrotated) };
}

/**
 * What identifies the image a recognition ran on, from the image alone (an annotation edit or
 * renumbering mustn't throw a finished recognition away). Dexie hands out a new Blob on every
 * read, so identity can't be compared: every image change while a page is 'processing' resets
 * it to 'pending' (updatePage, sync downloads), this catches one that changes the size, type
 * or source, and `sameImage` compares the bytes before the result is written.
 */
function imageToken(page: Page): string {
  const image = pageImage(page);
  const source = page.processedBlob ? 'processed' : page.originalBlob ? 'original' : 'none';
  return [source, image?.size ?? -1, image?.type ?? ''].join('|');
}

/** Whether the page still shows exactly the image that was recognized. */
async function sameImage(pageId: string, recognized: Blob): Promise<boolean> {
  const page = await db.pages.get(pageId);
  const image = page && pageImage(page);
  if (!image || image.size !== recognized.size) return false;
  const [a, b] = await Promise.all([image.arrayBuffer(), recognized.arrayBuffer()]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

/** Turn annotations with their image (clockwise, in 90° steps). Synchronous, for use in a transaction. */
function rotateAnnotations(
  annotations: Annotation[],
  size: { width: number; height: number },
  rotation: Rotation
): Annotation[] {
  let { width, height } = size;
  let turned = annotations;
  for (let step = 0; step < rotation; step += 90) {
    turned = rotateAnnotations90(turned, width, height);
    [width, height] = [height, width];
  }
  return turned;
}

/** Subscribe to "a page finished OCR" events (used by auto-naming). */
export function onPageOcrDone(listener: PageOcrListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tell listeners a page has new text; also used when a cloud model re-transcribes a page. */
export async function notifyPageOcrDone(documentId: string, pageNumber: number): Promise<void> {
  for (const listener of listeners) {
    try {
      await listener(documentId, pageNumber);
    } catch (err) {
      console.warn('OCR listener failed:', err);
    }
  }
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

      const pending = await db.pages.where('ocrStatus').equals('pending').toArray();
      for (const page of pending) {
        // Re-read and claim the page in one transaction, so the image recognized is the one
        // the page has when it turns 'processing' (a later image change resets it to 'pending')
        const current = await db.transaction('rw', db.pages, async () => {
          const fresh = await db.pages.get(page.id);
          // Deleted or changed while earlier pages were processing; a synced page whose image
          // hasn't downloaded yet stays pending until it has
          if (!fresh || fresh.ocrStatus !== 'pending' || !pageImage(fresh)) return undefined;
          await db.pages.update(page.id, { ocrStatus: 'processing' });
          return fresh;
        });
        if (!current) continue;
        const blob = pageImage(current)!;
        const token = imageToken(current);

        try {
          const langs = settings.ocrLanguages;
          // OCR and the orientation probes work on a bounded copy (OCR_MAX_DIMENSION)
          const { blob: ocrImage, scale } = await fitImage(blob, OCR_MAX_DIMENSION);
          // With Tesseract, an upside-down or sideways page is turned upright when that's
          // clearly where its text reads
          const { recognized, engine } = await recognizeWith(
            await ocrProviderFor(langs),
            ocrImage,
            langs,
            mayAutoOrient(current)
          );
          const upright = scaleToPage(recognized, scale);

          let result = upright.result;
          let turn: { image: Blob; rotation: Rotation; size?: { width: number; height: number } } | undefined;
          if (upright.rotation !== 0) {
            try {
              // The annotations are turned with the image, which needs its size
              const size = current.annotations?.length ? await getImageSize(blob) : undefined;
              // The page image itself is turned once, at full size, now that the turn is settled
              turn = { image: await rotateImage(blob, upright.rotation), rotation: upright.rotation, size };
            } catch (err) {
              console.warn('Could not turn the page upright; keeping it as scanned:', err);
              result = upright.unrotated ?? result;
            }
          }
          const { detectOcrLanguage } = await import('@/lib/language-detect');
          // Swapped for another image of the same size during recognition: recognize that one
          const unchanged = await sameImage(page.id, blob);
          const ocrFields = (r: OcrResult) => ({
            ocrStatus: 'done' as const,
            ocrText: r.text,
            ocrWords: r.words,
            ocrLang: langs.join('+'),
            ocrInfo: {
              engine,
              languages: [...langs],
              detectedLanguage: detectOcrLanguage(r.text),
              confidence: Math.round(r.confidence),
              recognizedAt: new Date(),
            },
          });

          // Check and write in one transaction (only Dexie awaits inside), so nothing can
          // change the page in between
          const written = await db.transaction('rw', db.pages, async () => {
            const after = await db.pages.get(page.id);
            if (!after) return undefined;
            if (after.ocrStatus !== 'processing') {
              // Its image changed and updatePage / sync reset it to 'pending': recognize that one
              if (after.ocrStatus === 'pending') rerunRequested = true;
              return undefined;
            }
            if (!unchanged || imageToken(after) !== token) {
              // Its image changed without a reset: recognize the new one on the next pass
              await db.pages.update(page.id, { ocrStatus: 'pending' });
              rerunRequested = true;
              return undefined;
            }
            let fields: Partial<Page> = ocrFields(result);
            let rotated = false;
            if (turn) {
              if (after.annotations?.length && !turn.size) {
                // Annotations appeared that can't be turned without the size: keep it as scanned
                fields = ocrFields(upright.unrotated ?? result);
              } else {
                fields = { ...fields, processedBlob: turn.image };
                if (after.annotations?.length && turn.size) {
                  fields.annotations = rotateAnnotations(after.annotations, turn.size, turn.rotation);
                }
                rotated = true;
              }
            }
            await db.pages.update(page.id, fields);
            return { pageNumber: after.pageNumber, rotated };
          });
          if (!written) continue;

          if (written.rotated && written.pageNumber === 1) await refreshThumbnail(page.id);
          await rebuildSearchText(page.documentId);
          await notifyPageOcrDone(page.documentId, written.pageNumber);
        } catch (err) {
          console.warn('OCR failed for page', page.id, err);
          // Only if it's still ours: a 'pending' from updatePage or sync means "recognize again"
          const marked = await db.pages
            .where('id')
            .equals(page.id)
            .filter((p) => p.ocrStatus === 'processing')
            .modify({ ocrStatus: 'error' });
          if (marked === 0) rerunRequested = true;
        }
      }
    } while (rerunRequested);
  } finally {
    running = false;
  }
}

async function refreshThumbnail(pageId: string): Promise<void> {
  try {
    const page = await db.pages.get(pageId);
    if (!page || !pageImage(page)) return;
    const thumbnailBlob = await createThumbnail(await getRenderedBlob(page));
    // Thumbnail only: it's local, and bumping updatedAt would sync a document edit nobody made
    await db.documents.update(page.documentId, { thumbnailBlob });
  } catch (err) {
    console.warn('Thumbnail refresh failed:', err);
  }
}

/** Pages left 'processing' by a closed tab will never finish; put them back in the queue. */
export async function resetStaleOcr(): Promise<void> {
  if (running) return;
  await db.pages.where('ocrStatus').equals('processing').modify({ ocrStatus: 'pending' });
}

// Re-queued pages keep their orientation: their first recognition was already attempted

export async function retryOcr(pageId: string): Promise<void> {
  await db.pages.update(pageId, { ocrStatus: 'pending', keepOrientation: true });
  await processPendingOcr();
}

/** Re-run OCR on every page of one document. */
export async function retryDocumentOcr(documentId: string): Promise<void> {
  await db.pages.where('documentId').equals(documentId).modify({ ocrStatus: 'pending', keepOrientation: true });
  await processPendingOcr();
}

/** Re-queue every page, e.g. after the OCR language changes. */
export async function requeueAllOcr(): Promise<void> {
  await db.pages.toCollection().modify({ ocrStatus: 'pending', keepOrientation: true });
  await processPendingOcr();
}
