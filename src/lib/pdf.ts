import type { OcrWord, Page } from '@/types';
import { requirePageImage } from '@/lib/page-image';

export interface PdfPageInput {
  blob: Blob;
  words?: OcrWord[];
}

/**
 * Pages as PDF input: annotations burned into the image, and OCR words only when they
 * were recognized from the page's current image.
 */
export async function pagesToPdfInput(
  pages: Page[],
  render: (page: Page) => Promise<Blob> = async (p) => requirePageImage(p)
): Promise<PdfPageInput[]> {
  return Promise.all(
    pages.map(async (p) => ({
      blob: await render(p),
      words: p.ocrStatus === 'done' ? p.ocrWords : undefined,
    }))
  );
}

export interface PdfTextPlacement {
  text: string;
  x: number;
  y: number;
  size: number;
  horizontalScale: number; // percent, stretches glyphs to span the word's bbox
}

// Characters Helvetica (WinAnsi) can encode, beyond printable ASCII
const WIN_ANSI_EXTRA = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿ÀÁÂÃÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖ×ØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõö÷øùúûüýþÿ'
);

/** Drop characters the standard PDF fonts can't encode so export never fails on odd OCR output. */
export function sanitizeWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if ((code >= 0x20 && code <= 0x7e) || WIN_ANSI_EXTRA.has(ch)) out += ch;
  }
  return out;
}

/**
 * Map an OCR word (image pixels, origin top-left) to a PDF text placement
 * (points, origin bottom-left). Pages are sized 1:1 with image pixels.
 */
export function wordToPdfPlacement(
  word: OcrWord,
  pageHeight: number,
  measureWidth: (text: string, size: number) => number
): PdfTextPlacement | null {
  const text = sanitizeWinAnsi(word.text);
  const { x0, y0, x1, y1 } = word.bbox;
  const boxW = x1 - x0;
  const boxH = y1 - y0;
  if (!text || boxW <= 0 || boxH <= 0) return null;

  const size = boxH;
  const naturalWidth = measureWidth(text, size);
  const horizontalScale = naturalWidth > 0 ? (boxW / naturalWidth) * 100 : 100;

  return {
    text,
    x: x0,
    // Baseline sits a little above the bbox bottom to account for descenders
    y: pageHeight - y1 + boxH * 0.2,
    size,
    horizontalScale,
  };
}

export async function generatePdf(pages: PdfPageInput[]): Promise<Blob> {
  const {
    PDFDocument,
    StandardFonts,
    TextRenderingMode,
    setCharacterSqueeze,
    setTextRenderingMode,
    pushGraphicsState,
    popGraphicsState,
  } = await import('pdf-lib');
  const pdfDoc = await PDFDocument.create();
  const hasText = pages.some((p) => p.words && p.words.length > 0);
  const font = hasText ? await pdfDoc.embedFont(StandardFonts.Helvetica) : null;

  for (const { blob, words } of pages) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let image;

    // Try JPEG first, fall back to PNG
    try {
      image = await pdfDoc.embedJpg(bytes);
    } catch {
      image = await pdfDoc.embedPng(bytes);
    }

    const page = pdfDoc.addPage([image.width, image.height]);
    page.drawImage(image, {
      x: 0,
      y: 0,
      width: image.width,
      height: image.height,
    });

    // Invisible text layer so the PDF is searchable and selectable
    if (font && words) {
      for (const word of words) {
        const placement = wordToPdfPlacement(word, image.height, (t, size) =>
          font.widthOfTextAtSize(t, size)
        );
        if (!placement) continue;
        page.pushOperators(
          pushGraphicsState(),
          setTextRenderingMode(TextRenderingMode.Invisible),
          setCharacterSqueeze(placement.horizontalScale)
        );
        page.drawText(placement.text, {
          x: placement.x,
          y: placement.y,
          size: placement.size,
          font,
        });
        page.pushOperators(popGraphicsState());
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  return new Blob([pdfBytes as BlobPart], { type: 'application/pdf' });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking synchronously can abort the download in Safari/WebKit
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function shareOrDownload(
  blob: Blob,
  filename: string,
  title?: string
): Promise<void> {
  // Try native share first (mobile)
  if (typeof navigator !== 'undefined' && navigator.share && navigator.canShare) {
    try {
      const file = new File([blob], filename, { type: blob.type });
      const shareData = { title: title || filename, files: [file] };

      if (navigator.canShare(shareData)) {
        await navigator.share(shareData);
        return;
      }
    } catch (err) {
      // User cancelled or share failed, fall through to download
      if ((err as Error).name === 'AbortError') return;
      console.warn('Share API error, falling back to download:', err);
    }
  }

  // Fall back to download
  downloadBlob(blob, filename);
}

export async function shareImage(
  imageBlob: Blob,
  filename: string,
  title?: string
): Promise<void> {
  return shareOrDownload(imageBlob, filename, title);
}
