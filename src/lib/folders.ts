/**
 * Flat folders. A document is in at most one folder (`ScannedDocument.folderId`); a document
 * without one — or whose folder no longer exists — is unfiled.
 */
import { nanoid } from 'nanoid';
import { db } from './db';
import type { Folder } from '@/types';

export const MAX_FOLDER_NAME_LENGTH = 60;

export class FolderNameError extends Error {}

export function normalizeFolderName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER_NAME_LENGTH).trim();
}

export function sortFolders(folders: readonly Folder[]): Folder[] {
  return [...folders].sort(
    (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || a.id.localeCompare(b.id)
  );
}

async function checkName(raw: string, exceptId?: string): Promise<string> {
  const name = normalizeFolderName(raw);
  if (!name) throw new FolderNameError('Enter a folder name.');
  const key = name.toLocaleLowerCase();
  const taken = await db.folders.filter((f) => f.id !== exceptId && f.name.toLocaleLowerCase() === key).count();
  if (taken > 0) throw new FolderNameError(`There’s already a folder called “${name}”.`);
  return name;
}

/** Creates a folder and returns its id. Throws FolderNameError for an empty or duplicate name. */
export async function createFolder(rawName: string): Promise<string> {
  return db.transaction('rw', db.folders, async () => {
    const name = await checkName(rawName);
    const now = new Date();
    const id = nanoid();
    await db.folders.add({ id, name, createdAt: now, updatedAt: now });
    return id;
  });
}

/** Throws FolderNameError for an empty or duplicate name. */
export async function renameFolder(id: string, rawName: string): Promise<void> {
  await db.transaction('rw', db.folders, async () => {
    const name = await checkName(rawName, id);
    await db.folders.update(id, { name, updatedAt: new Date() });
  });
}

/**
 * Deletes a folder. Its documents are kept and become unfiled.
 * Returns the number of documents that were in it.
 */
export async function deleteFolder(id: string): Promise<number> {
  return db.transaction('rw', [db.folders, db.documents], async () => {
    const docs = await db.documents.where('folderId').equals(id).toArray();
    const now = new Date();
    for (const doc of docs) {
      await db.documents.update(doc.id, { folderId: undefined, updatedAt: now });
    }
    await db.folders.delete(id);
    return docs.length;
  });
}

/** Files a document in a folder, or unfiles it with `null`. */
export async function moveDocumentToFolder(documentId: string, folderId: string | null): Promise<void> {
  await db.transaction('rw', [db.folders, db.documents], async () => {
    const doc = await db.documents.get(documentId);
    if (!doc) return;
    if (folderId && !(await db.folders.get(folderId))) throw new Error('Folder not found');
    if ((doc.folderId ?? null) === folderId) return;
    await db.documents.update(documentId, { folderId: folderId ?? undefined, updatedAt: new Date() });
  });
}
