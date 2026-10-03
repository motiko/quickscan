/**
 * Free-form document tags.
 *
 * Tags live on the documents themselves (`ScannedDocument.tags`) — there is no tag table, so the
 * set of tags is always exactly what documents carry and there is nothing to keep in sync.
 * Tags compare case-insensitively; a new tag reuses the spelling of an existing one.
 */
import { db } from './db';
import type { ScannedDocument } from '@/types';

export const MAX_TAG_LENGTH = 40;

/** Trim, collapse whitespace, drop a leading '#' and cap the length. Empty when nothing is left. */
export function normalizeTag(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^#+\s*/, '')
    .slice(0, MAX_TAG_LENGTH)
    .trim();
}

/** Key tags are compared by. */
export function tagKey(tag: string): string {
  return tag.toLocaleLowerCase();
}

export function compareTags(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

/** Normalized, de-duplicated (case-insensitively, first spelling wins) and sorted. */
export function cleanTags(tags: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const raw of tags) {
    const tag = normalizeTag(raw);
    if (tag && !seen.has(tagKey(tag))) seen.set(tagKey(tag), tag);
  }
  return [...seen.values()].sort(compareTags);
}

/** The spelling to store for `raw`: an existing tag's spelling if one matches, else `raw` normalized. */
export function canonicalTag(raw: string, existing: readonly string[]): string {
  const tag = normalizeTag(raw);
  return existing.find((t) => tagKey(t) === tagKey(tag)) ?? tag;
}

export function hasTag(tags: readonly string[] | undefined, tag: string): boolean {
  const key = tagKey(tag);
  return !!tags?.some((t) => tagKey(t) === key);
}

export interface TagCount {
  tag: string;
  count: number;
}

/** Every tag used by `documents`, with how many documents carry it, sorted by name. */
export function collectTags(documents: readonly Pick<ScannedDocument, 'tags'>[]): TagCount[] {
  const counts = new Map<string, TagCount>();
  for (const doc of documents) {
    for (const tag of doc.tags ?? []) {
      const entry = counts.get(tagKey(tag));
      if (entry) entry.count++;
      else counts.set(tagKey(tag), { tag, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => compareTags(a.tag, b.tag));
}

/** Existing tags matching what's typed (prefix matches first), leaving out tags already applied. */
export function suggestTags(
  input: string,
  allTags: readonly string[],
  applied: readonly string[] = [],
  limit = 8
): string[] {
  const query = tagKey(normalizeTag(input));
  const candidates = allTags.filter((t) => !hasTag(applied, t));
  if (!query) return candidates.slice(0, limit);
  const prefix = candidates.filter((t) => tagKey(t).startsWith(query));
  const infix = candidates.filter((t) => !tagKey(t).startsWith(query) && tagKey(t).includes(query));
  return [...prefix, ...infix].slice(0, limit);
}

/**
 * All tags in use, sorted. Read with `keys()`, not `uniqueKeys()`: WebKit can't open a
 * unique-direction cursor on a multi-entry index ("UnknownError: Unable to open cursor"), and
 * the error took down every page that lists tags in Safari. `cleanTags` drops the duplicates.
 */
export async function getAllTags(): Promise<string[]> {
  const keys = (await db.documents.orderBy('tags').keys()) as string[];
  return cleanTags(keys);
}

/** Adds a tag to a document. Returns the stored spelling, or null when the tag is empty. */
export async function addTagToDocument(documentId: string, raw: string): Promise<string | null> {
  if (!normalizeTag(raw)) return null;
  const tag = canonicalTag(raw, await getAllTags());
  await db.transaction('rw', db.documents, async () => {
    const doc = await db.documents.get(documentId);
    if (!doc || hasTag(doc.tags, tag)) return;
    await db.documents.update(documentId, { tags: cleanTags([...(doc.tags ?? []), tag]), updatedAt: new Date() });
  });
  return tag;
}

export async function removeTagFromDocument(documentId: string, tag: string): Promise<void> {
  await db.transaction('rw', db.documents, async () => {
    const doc = await db.documents.get(documentId);
    if (!doc || !hasTag(doc.tags, tag)) return;
    const tags = (doc.tags ?? []).filter((t) => tagKey(t) !== tagKey(tag));
    await db.documents.update(documentId, { tags, updatedAt: new Date() });
  });
}

/** Documents carrying `tag` in any spelling. */
function documentsWithTag(tag: string) {
  const key = tagKey(tag);
  return db.documents.filter((d) => !!d.tags?.some((t) => tagKey(t) === key));
}

/**
 * Renames a tag on every document. Renaming onto another existing tag merges the two.
 * Returns the number of documents changed.
 */
export async function renameTag(from: string, to: string): Promise<number> {
  const next = normalizeTag(to);
  if (!next) throw new Error('Tag name can’t be empty');
  return db.transaction('rw', db.documents, async () => {
    const docs = await documentsWithTag(from).toArray();
    const now = new Date();
    for (const doc of docs) {
      const kept = (doc.tags ?? []).filter((t) => tagKey(t) !== tagKey(from));
      // The new name wins over an existing tag that differs only in case
      const tags = cleanTags([next, ...kept.filter((t) => tagKey(t) !== tagKey(next))]);
      await db.documents.update(doc.id, { tags, updatedAt: now });
    }
    return docs.length;
  });
}

/** Removes a tag from every document. Returns the number of documents changed. */
export async function deleteTag(tag: string): Promise<number> {
  return db.transaction('rw', db.documents, async () => {
    const docs = await documentsWithTag(tag).toArray();
    const now = new Date();
    for (const doc of docs) {
      const tags = (doc.tags ?? []).filter((t) => tagKey(t) !== tagKey(tag));
      await db.documents.update(doc.id, { tags, updatedAt: now });
    }
    return docs.length;
  });
}
