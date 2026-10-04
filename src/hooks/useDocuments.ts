'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import { createThumbnail } from '@/lib/image-processing';
import { rebuildSearchText } from '@/lib/ocr-queue';
import { getRenderedBlob } from '@/lib/annotations/flatten';
import { hasPageImage } from '@/lib/page-image';
import type { ScannedDocument, Page, ImageFilter, Annotation } from '@/types';

export function useDocuments() {
  const documents = useLiveQuery(
    () => db.documents.orderBy('updatedAt').reverse().toArray(),
    []
  );

  return { documents: documents ?? [], isLoading: documents === undefined };
}

export function useDocument(id: string) {
  const document = useLiveQuery(() => db.documents.get(id), [id]);
  const pages = useLiveQuery(
    () => db.pages.where('documentId').equals(id).sortBy('pageNumber'),
    [id]
  );

  return {
    document: document ?? null,
    pages: pages ?? [],
    isLoading: document === undefined,
  };
}

export async function createDocument(
  name: string,
  firstPageBlob: Blob,
  nameSource: ScannedDocument['nameSource'] = 'default'
): Promise<string> {
  return createDocumentWithPages(name, [firstPageBlob], nameSource);
}

/**
 * A new document with these pages, in order, written in one transaction, so OCR can't pick
 * up page 1 while later pages are still being added. OCR's record updates rewrite the
 * records' blobs, and in WebKit (iOS app) such rewrites racing with other writes left blobs
 * pointing at deleted files (docs/native/android.md, "System document scanner").
 */
export async function createDocumentWithPages(
  name: string,
  pageBlobs: Blob[],
  nameSource: ScannedDocument['nameSource'] = 'default'
): Promise<string> {
  if (pageBlobs.length === 0) throw new Error('A document needs at least one page');
  const docId = nanoid();
  const now = new Date();
  const thumbnailBlob = await createThumbnail(pageBlobs[0]);

  await db.transaction('rw', [db.documents, db.pages], async () => {
    await db.documents.add({
      id: docId,
      name,
      createdAt: now,
      updatedAt: now,
      pageCount: pageBlobs.length,
      thumbnailBlob,
      nameSource,
    });

    await db.pages.bulkAdd(pageBlobs.map((blob, i) => newPage(docId, i + 1, blob, 'original', now)));
  });

  return docId;
}

function newPage(documentId: string, pageNumber: number, blob: Blob, filter: ImageFilter, now: Date): Page {
  return {
    id: nanoid(),
    documentId,
    pageNumber,
    originalBlob: blob,
    processedBlob: blob,
    filter,
    createdAt: now,
    updatedAt: now,
    ocrStatus: 'pending',
  };
}

/** Append pages, in order, to a document in one transaction (see createDocumentWithPages). */
export async function addPagesToDocument(documentId: string, pageBlobs: Blob[]): Promise<void> {
  const now = new Date();
  await db.transaction('rw', [db.documents, db.pages], async () => {
    const doc = await db.documents.get(documentId);
    if (!doc) throw new Error('Document not found');
    await db.pages.bulkAdd(pageBlobs.map((blob, i) => newPage(documentId, doc.pageCount + i + 1, blob, 'original', now)));
    await db.documents.update(documentId, { pageCount: doc.pageCount + pageBlobs.length, updatedAt: now });
  });
}

export async function addPageToDocument(
  documentId: string,
  imageBlob: Blob,
  filter: ImageFilter = 'original'
): Promise<string> {
  const pageId = nanoid();
  const now = new Date();

  const doc = await db.documents.get(documentId);
  if (!doc) throw new Error('Document not found');

  const newPageNumber = doc.pageCount + 1;

  await db.transaction('rw', [db.documents, db.pages], async () => {
    await db.pages.add({
      id: pageId,
      documentId,
      pageNumber: newPageNumber,
      originalBlob: imageBlob,
      processedBlob: imageBlob,
      filter,
      createdAt: now,
      updatedAt: now,
      ocrStatus: 'pending',
    });

    await db.documents.update(documentId, {
      pageCount: newPageNumber,
      updatedAt: now,
    });
  });

  return pageId;
}

export async function updatePage(
  pageId: string,
  updates: Partial<Pick<Page, 'processedBlob' | 'filter' | 'corners' | 'annotations'>>
): Promise<void> {
  // A new image invalidates any text recognized from the old one; one changed by hand (turned)
  // is the orientation the user wants, so OCR mustn't turn it upright on its own
  const ocrReset = updates.processedBlob ? { ocrStatus: 'pending' as const, keepOrientation: true } : {};
  await db.pages.update(pageId, { ...updates, ...ocrReset });
}

export async function deletePage(pageId: string): Promise<void> {
  const page = await db.pages.get(pageId);
  if (!page) return;

  await db.transaction('rw', [db.documents, db.pages], async () => {
    await db.pages.delete(pageId);

    const remaining = await db.pages
      .where('documentId')
      .equals(page.documentId)
      .sortBy('pageNumber');

    for (let i = 0; i < remaining.length; i++) {
      await db.pages.update(remaining[i].id, { pageNumber: i + 1 });
    }

    const doc = await db.documents.get(page.documentId);
    if (doc) {
      const newCount = remaining.length;
      if (newCount === 0) {
        await db.documents.delete(page.documentId);
      } else {
        const newFirst = remaining[0];
        const updates: Partial<ScannedDocument> = {
          pageCount: newCount,
          updatedAt: new Date(),
        };
        if (page.pageNumber === 1) {
          // A synced page may not have its image yet; sync rebuilds the thumbnail when it arrives
          updates.thumbnailBlob = hasPageImage(newFirst)
            ? await createThumbnail(await getRenderedBlob(newFirst))
            : undefined;
        }
        await db.documents.update(page.documentId, updates);
      }
    }
  });

  if (await db.documents.get(page.documentId)) {
    await rebuildSearchText(page.documentId);
  }
}

/** Store a page's annotations and keep the gallery thumbnail in sync when it's the first page. */
export async function savePageAnnotations(pageId: string, annotations: Annotation[]): Promise<void> {
  await db.pages.update(pageId, { annotations });
  const page = await db.pages.get(pageId);
  if (page?.pageNumber === 1 && hasPageImage(page)) {
    const thumbnailBlob = await createThumbnail(await getRenderedBlob(page));
    await db.documents.update(page.documentId, { thumbnailBlob, updatedAt: new Date() });
  }
}

/** Keep a conflicted copy as an ordinary page (drops its "Conflicted copy" label; syncs). */
export async function keepConflictedCopy(pageId: string): Promise<void> {
  await db.pages.update(pageId, { conflictOf: undefined });
}

export async function deleteDocument(documentId: string): Promise<void> {
  await db.transaction('rw', [db.documents, db.pages], async () => {
    await db.pages.where('documentId').equals(documentId).delete();
    await db.documents.delete(documentId);
  });
}

export async function renameDocument(
  documentId: string,
  name: string
): Promise<void> {
  await db.documents.update(documentId, { name, nameSource: 'user', updatedAt: new Date() });
}
