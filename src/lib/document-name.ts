import type { ScannedDocument } from '@/types';

// The names the app generates before a document has a meaningful one:
// "Scan YYYY-MM-DD HH:MM" (camera, see app/scan) and "Upload YYYY-MM-DD HH:MM" (lib/import).
const DEFAULT_NAME = /^(?:Scan|Upload) \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

/**
 * Whether a document still carries a generated timestamp name. Checks the name itself rather
 * than `nameSource`, so documents created before that field existed count too, and a default
 * name auto-naming could not replace (no text yet) still does.
 */
export function isDefaultDocumentName(name: string): boolean {
  return DEFAULT_NAME.test(name.trim());
}

/**
 * A short line of the document's text to tell apart documents with a generated name: the
 * summary when there is one, else the recognized text. Whitespace is collapsed; empty when
 * there is nothing to show.
 */
export function documentSnippet(
  doc: Pick<ScannedDocument, 'summary' | 'searchText'>,
  maxLength = 120
): string {
  const text = (doc.summary?.text || doc.searchText || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength).trimEnd()}…` : text;
}
