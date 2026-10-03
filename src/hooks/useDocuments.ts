'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { nanoid } from 'nanoid';
import { db } from '@/lib/db';
import { createThumbnail } from '@/lib/image-processing';
import { rebuildSearchText } from '@/lib/ocr-queue';
import { getRenderedBlob } from '@/lib/annotations/flatten';
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
  const docId = nanoid();
  const pageId = nanoid();
  const now = new Date();
  const thumbnailBlob = await createThumbnail(firstPageBlob);

  await db.transaction('rw', [db.documents, db.pages], async () => {
    await db.documents.add({
      id: docId,
      name,
      createdAt: now,
      updatedAt: now,
      pageCount: 1,
      thumbnailBlob,
      nameSource,
    });

    await db.pages.add({
      id: pageId,
      documentId: docId,
      pageNumber: 1,
      originalBlob: firstPageBlob,
      processedBlob: firstPageBlob,
      filter: 'original',
      createdAt: now,
      updatedAt: now,
      ocrStatus: 'pending',
    });
  });

  return docId;
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
  // A new image invalidates any text recognized from the old one
  const ocrReset = updates.processedBlob ? { ocrStatus: 'pending' as const } : {};
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
          updates.thumbnailBlob = await createThumbnail(await getRenderedBlob(newFirst));
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
  if (page?.pageNumber === 1) {
    const thumbnailBlob = await createThumbnail(await getRenderedBlob(page));
    await db.documents.update(page.documentId, { thumbnailBlob, updatedAt: new Date() });
  }
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
