import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import type { ScannedDocument } from '@/types';

/*
 * Every stored image (page originals and processed images, gallery thumbnails) is a row of its
 * own in `images`, which records point to by id. A row is written once and never changed: a
 * new image is a new row. WebKit's IndexedDB loses Blobs when a record holding one is rewritten
 * while the old Blob is still being read or shown (#89), and pages and documents are rewritten
 * all the time (OCR status, search text, names, sync). The images of deleted pages and
 * documents are deleted with them (deleteImagesIfUnused). An image that was replaced (a turned
 * page, a new thumbnail) may still be on screen or being read, here or in another tab, so it
 * goes later: pruneOrphanImages (image-migration.ts) deletes it at a start once it was already
 * unused at an earlier one.
 */

export interface StoredImage {
  id: string;
  blob: Blob;
  createdAt: Date;
}

/**
 * Store a new image and return its id. Inside a transaction (which must include `db.images`),
 * the row is written with it, so the record pointing to it can't be written without it.
 */
export async function putImage(blob: Blob): Promise<string> {
  const id = nanoid();
  await db.images.add({ id, blob, createdAt: new Date() });
  return id;
}

/**
 * Delete these images unless a page or document still points to one (conflicted copies share
 * their page's image; a capture's original and processed image are often one row). Inside a
 * transaction, that one must include `pages`, `documents` and `images`; call it after the
 * records are deleted.
 */
export async function deleteImagesIfUnused(ids: Iterable<string | undefined>): Promise<void> {
  const unique = [...new Set([...ids].filter((id): id is string => !!id))];
  if (unique.length === 0) return;
  await db.transaction('rw', [db.pages, db.documents, db.images], async () => {
    const unused: string[] = [];
    for (const id of unique) {
      const used =
        (await db.pages.where('processedImageId').equals(id).count()) +
        (await db.pages.where('originalImageId').equals(id).count()) +
        (await db.documents.where('thumbnailId').equals(id).count());
      if (used === 0) unused.push(id);
    }
    await db.images.bulkDelete(unused);
  });
}

/** Image ids a page or document points to. */
export function imageIdsOf(record: { processedImageId?: string; originalImageId?: string; thumbnailId?: string }): string[] {
  return [record.processedImageId, record.originalImageId, record.thumbnailId].filter((id): id is string => !!id);
}

export async function getImage(id: string | undefined): Promise<Blob | undefined> {
  if (!id) return undefined;
  return (await db.images.get(id))?.blob;
}


/**
 * Store a new gallery thumbnail and point the document to it, with any other document fields,
 * in one transaction. Inside a transaction, that one must include `documents` and `images`.
 */
export async function setThumbnail(
  documentId: string,
  blob: Blob,
  fields: Partial<Omit<ScannedDocument, 'id' | 'thumbnailId'>> = {}
): Promise<void> {
  await db.transaction('rw', [db.documents, db.images], async () => {
    const thumbnailId = await putImage(blob);
    await db.documents.update(documentId, { ...fields, thumbnailId });
  });
}
