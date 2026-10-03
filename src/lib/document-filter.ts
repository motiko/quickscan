/** Gallery filtering by folder, tags and search text. Pure functions, no database access. */
import type { ScannedDocument } from '@/types';
import { tagKey } from './tags';

/** Which documents to show: everything, only unfiled ones, or one folder's. */
export type FolderFilter = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'folder'; id: string };

export interface DocumentFilter {
  folder: FolderFilter;
  /** A document must carry every one of these tags (case-insensitive). */
  tags: string[];
  query: string;
}

export const EMPTY_FILTER: DocumentFilter = { folder: { kind: 'all' }, tags: [], query: '' };

/** The folder a document is in, treating a reference to a deleted folder as unfiled. */
export function effectiveFolderId(
  doc: Pick<ScannedDocument, 'folderId'>,
  folderIds: ReadonlySet<string>
): string | undefined {
  return doc.folderId && folderIds.has(doc.folderId) ? doc.folderId : undefined;
}

export function matchesFolder(
  doc: Pick<ScannedDocument, 'folderId'>,
  filter: FolderFilter,
  folderIds: ReadonlySet<string>
): boolean {
  if (filter.kind === 'all') return true;
  const folderId = effectiveFolderId(doc, folderIds);
  return filter.kind === 'unfiled' ? folderId === undefined : folderId === filter.id;
}

export function matchesTags(doc: Pick<ScannedDocument, 'tags'>, tags: readonly string[]): boolean {
  if (tags.length === 0) return true;
  const own = new Set((doc.tags ?? []).map(tagKey));
  return tags.every((t) => own.has(tagKey(t)));
}

/** Search over the name, recognized text, summary and tags. */
export function matchesQuery(doc: ScannedDocument, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    doc.name.toLowerCase().includes(q) ||
    !!doc.searchText?.includes(q) ||
    !!doc.summary?.text.toLowerCase().includes(q) ||
    !!doc.tags?.some((t) => t.toLowerCase().includes(q))
  );
}

export function filterDocuments(
  documents: readonly ScannedDocument[],
  filter: DocumentFilter,
  folderIds: ReadonlySet<string>
): ScannedDocument[] {
  return documents.filter(
    (doc) =>
      matchesFolder(doc, filter.folder, folderIds) &&
      matchesTags(doc, filter.tags) &&
      matchesQuery(doc, filter.query)
  );
}

export function isFiltering(filter: DocumentFilter): boolean {
  return filter.folder.kind !== 'all' || filter.tags.length > 0 || filter.query.trim() !== '';
}

/** Number of documents per folder id, plus unfiled ones under `null`. */
export function countByFolder(
  documents: readonly Pick<ScannedDocument, 'folderId'>[],
  folderIds: ReadonlySet<string>
): Map<string | null, number> {
  const counts = new Map<string | null, number>();
  for (const doc of documents) {
    const key = effectiveFolderId(doc, folderIds) ?? null;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}
