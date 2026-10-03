import { db } from '@/lib/db';
import { applyUnverifiedDeletion, ignoreUnverifiedDeletion } from './engine';
import { withSyncLock } from './lock';
import { defaultThumbnail, requestSync } from './runner';
import { unverifiedKey, type UnverifiedDeletion } from './state';

/*
 * Deletions that arrived without an authenticated payload (see engine.ts, "Tombstones are
 * authenticated"), as Settings → Sync problems lists them: the user applies or ignores each.
 */

export type { UnverifiedDeletion };

export interface UnverifiedDeletionItem extends UnverifiedDeletion {
  /** What the record is called on this device. */
  name: string;
}

/** The held deletions whose record is still on this device, with a name to show. */
export async function listUnverifiedDeletions(userId: string): Promise<UnverifiedDeletionItem[]> {
  const held = ((await db.syncMeta.get(unverifiedKey(userId)))?.value as UnverifiedDeletion[] | undefined) ?? [];
  const items: UnverifiedDeletionItem[] = [];
  for (const d of held) {
    const name = await recordName(d);
    if (name !== null) items.push({ ...d, name });
  }
  return items;
}

/** Null when the record is gone from this device. */
async function recordName({ kind, id }: UnverifiedDeletion): Promise<string | null> {
  switch (kind) {
    case 'document': {
      const doc = await db.documents.get(id);
      if (doc) return doc.name;
      return (await db.pages.where('documentId').equals(id).count()) > 0 ? 'a document' : null;
    }
    case 'page': {
      const page = await db.pages.get(id);
      if (!page) return null;
      const doc = await db.documents.get(page.documentId);
      return doc ? `${doc.name}, page ${page.pageNumber}` : `page ${page.pageNumber}`;
    }
    case 'folder':
      return (await db.folders.get(id))?.name ?? null;
    case 'signature':
      return (await db.signatures.get(id)) ? 'a signature' : null;
    case 'settings':
      return (await db.settings.get(id)) ? (id === 'ocrLanguages' ? 'OCR languages' : id) : null;
    default:
      return null;
  }
}

/** "Apply deletion": delete the record on this device. */
export async function applyDeletion(userId: string, deletion: UnverifiedDeletion): Promise<void> {
  await withSyncLock(() => applyUnverifiedDeletion(userId, deletion, { makeThumbnail: defaultThumbnail }));
}

/** "Ignore": keep the record and restore it on the server. */
export async function ignoreDeletion(userId: string, deletion: UnverifiedDeletion): Promise<void> {
  const queued = await withSyncLock(() => ignoreUnverifiedDeletion(userId, deletion));
  if (queued) void requestSync();
}
