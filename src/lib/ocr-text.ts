import { Page } from '@/types';

/** Joins the recognized text of all OCR-complete pages, in the given order. */
export function collectDocumentText(pages: Pick<Page, 'ocrStatus' | 'ocrText'>[]): string {
  return pages
    .map((p) => (p.ocrStatus === 'done' ? p.ocrText?.trim() ?? '' : ''))
    .filter(Boolean)
    .join('\n\n');
}
