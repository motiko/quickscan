import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '@/lib/db';
import {
  createFolder,
  deleteFolder,
  FolderNameError,
  moveDocumentToFolder,
  normalizeFolderName,
  renameFolder,
  sortFolders,
} from '@/lib/folders';
import {
  addTagToDocument,
  canonicalTag,
  cleanTags,
  collectTags,
  deleteTag,
  getAllTags,
  normalizeTag,
  removeTagFromDocument,
  renameTag,
  suggestTags,
} from '@/lib/tags';
import type { ScannedDocument } from '@/types';

const old = new Date('2026-01-01T00:00:00Z');

async function addDoc(id: string, overrides: Partial<ScannedDocument> = {}) {
  await db.documents.add({ id, name: id, createdAt: old, updatedAt: old, pageCount: 1, ...overrides });
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('folders', () => {
  it('creates folders with string ids and timestamps', async () => {
    const id = await createFolder('  Receipts  ');
    expect(typeof id).toBe('string');
    const folder = await db.folders.get(id);
    expect(folder?.name).toBe('Receipts');
    expect(folder?.createdAt).toBeInstanceOf(Date);
    expect(folder?.updatedAt).toEqual(folder?.createdAt);
  });

  it('rejects empty and duplicate names, case-insensitively', async () => {
    await createFolder('Receipts');
    await expect(createFolder('   ')).rejects.toBeInstanceOf(FolderNameError);
    await expect(createFolder('receipts')).rejects.toBeInstanceOf(FolderNameError);
    expect(await db.folders.count()).toBe(1);
  });

  it('renames a folder and bumps updatedAt', async () => {
    const id = await createFolder('Recipts');
    const before = (await db.folders.get(id))!.updatedAt;
    await new Promise((r) => setTimeout(r, 2));
    await renameFolder(id, 'Receipts');
    const folder = (await db.folders.get(id))!;
    expect(folder.name).toBe('Receipts');
    expect(folder.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    // Renaming to its own name in another case is fine
    await renameFolder(id, 'RECEIPTS');
    const other = await createFolder('Taxes');
    await expect(renameFolder(other, 'receipts')).rejects.toBeInstanceOf(FolderNameError);
  });

  it('moves documents into and out of folders', async () => {
    await addDoc('d1');
    const id = await createFolder('Work');
    await moveDocumentToFolder('d1', id);
    let doc = (await db.documents.get('d1'))!;
    expect(doc.folderId).toBe(id);
    expect(doc.updatedAt.getTime()).toBeGreaterThan(old.getTime());

    await moveDocumentToFolder('d1', null);
    doc = (await db.documents.get('d1'))!;
    expect('folderId' in doc).toBe(false);

    await expect(moveDocumentToFolder('d1', 'nope')).rejects.toThrow('Folder not found');
  });

  it('deleting a folder keeps its documents and unfiles them', async () => {
    const work = await createFolder('Work');
    const home = await createFolder('Home');
    await addDoc('d1', { folderId: work });
    await addDoc('d2', { folderId: work });
    await addDoc('d3', { folderId: home });

    expect(await deleteFolder(work)).toBe(2);

    expect(await db.folders.get(work)).toBeUndefined();
    const docs = await db.documents.orderBy('id').toArray();
    expect(docs.map((d) => [d.id, d.folderId])).toEqual([
      ['d1', undefined],
      ['d2', undefined],
      ['d3', home],
    ]);
    expect(docs[0].updatedAt.getTime()).toBeGreaterThan(old.getTime());
    expect(docs[2].updatedAt).toEqual(old);
  });

  it('normalizes and sorts names', () => {
    expect(normalizeFolderName('  a   b ')).toBe('a b');
    const f = (id: string, name: string) => ({ id, name, createdAt: old, updatedAt: old });
    expect(
      sortFolders([f('1', 'b'), f('2', 'Folder 10'), f('3', 'A'), f('4', 'Folder 9')]).map((x) => x.name)
    ).toEqual(['A', 'b', 'Folder 9', 'Folder 10']);
  });
});

describe('tag helpers', () => {
  it('normalizes tags', () => {
    expect(normalizeTag('  #Tax   2026 ')).toBe('Tax 2026');
    expect(normalizeTag('#')).toBe('');
    expect(normalizeTag('x'.repeat(100))).toHaveLength(40);
  });

  it('cleans, de-duplicates and sorts', () => {
    expect(cleanTags(['b', 'A', 'a', ' ', 'B '])).toEqual(['A', 'b']);
  });

  it('reuses the spelling of an existing tag', () => {
    expect(canonicalTag('tax', ['Tax', 'Work'])).toBe('Tax');
    expect(canonicalTag(' New ', ['Tax'])).toBe('New');
  });

  it('suggests prefix matches first and skips applied tags', () => {
    const all = ['Contract', 'Tax', 'Taxi', 'Syntax'];
    expect(suggestTags('tax', all)).toEqual(['Tax', 'Taxi', 'Syntax']);
    expect(suggestTags('tax', all, ['TAX'])).toEqual(['Taxi', 'Syntax']);
    expect(suggestTags('', all, ['Tax'])).toEqual(['Contract', 'Taxi', 'Syntax']);
  });

  it('collects tags with counts', () => {
    expect(collectTags([{ tags: ['b', 'a'] }, { tags: ['A'] }, {}])).toEqual([
      { tag: 'a', count: 2 },
      { tag: 'b', count: 1 },
    ]);
  });
});

describe('tags on documents', () => {
  it('adds tags, reusing existing spellings and skipping duplicates', async () => {
    await addDoc('d1', { tags: ['Tax'] });
    await addDoc('d2');
    expect(await addTagToDocument('d2', ' tax ')).toBe('Tax');
    expect(await addTagToDocument('d2', 'Work')).toBe('Work');
    expect(await addTagToDocument('d2', 'TAX')).toBe('Tax');
    expect(await addTagToDocument('d2', '   ')).toBeNull();
    const doc = (await db.documents.get('d2'))!;
    expect(doc.tags).toEqual(['Tax', 'Work']);
    expect(doc.updatedAt.getTime()).toBeGreaterThan(old.getTime());
    expect(await getAllTags()).toEqual(['Tax', 'Work']);
  });

  it('removes a tag from one document', async () => {
    await addDoc('d1', { tags: ['Tax', 'Work'] });
    await removeTagFromDocument('d1', 'tax');
    expect((await db.documents.get('d1'))!.tags).toEqual(['Work']);
  });

  it('renames a tag everywhere and merges into an existing one', async () => {
    await addDoc('d1', { tags: ['Tax', 'Work'] });
    await addDoc('d2', { tags: ['Taxes', 'Tax'] });
    await addDoc('d3', { tags: ['Home'] });

    expect(await renameTag('Tax', 'Taxes')).toBe(2);
    expect((await db.documents.get('d1'))!.tags).toEqual(['Taxes', 'Work']);
    expect((await db.documents.get('d2'))!.tags).toEqual(['Taxes']);
    expect((await db.documents.get('d3'))!.updatedAt).toEqual(old);

    // Changing only the case works too
    await renameTag('taxes', 'TAXES');
    expect(await getAllTags()).toEqual(['Home', 'TAXES', 'Work']);
    await expect(renameTag('Home', ' ')).rejects.toThrow();
  });

  it('deletes a tag everywhere and keeps the documents', async () => {
    await addDoc('d1', { tags: ['Tax', 'Work'] });
    await addDoc('d2', { tags: ['tax'] });
    expect(await deleteTag('TAX')).toBe(2);
    expect(await db.documents.count()).toBe(2);
    expect((await db.documents.get('d1'))!.tags).toEqual(['Work']);
    expect((await db.documents.get('d2'))!.tags).toEqual([]);
    expect(await getAllTags()).toEqual(['Work']);
  });
});
