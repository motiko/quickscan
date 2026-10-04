import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/image-processing', () => ({ createThumbnail: vi.fn(async () => new Blob(['thumb'])) }));
vi.mock('@/lib/annotations/flatten', () => ({ getRenderedBlob: vi.fn(async () => new Blob(['rendered'])) }));

import { db } from '@/lib/db';
import {
  addPageToDocument,
  addPagesToDocument,
  createDocument,
  createDocumentWithPages,
  deleteDocument,
  deletePage,
  renameDocument,
  savePageAnnotations,
  updatePage,
} from '@/hooks/useDocuments';
import { createFolder, deleteFolder, renameFolder } from '@/lib/folders';
import { addTagToDocument } from '@/lib/tags';
import { updateSettings } from '@/lib/settings';
import { ackOutbox, applyUntracked, getDeviceId, getOutboxEntry, readOutbox } from '@/lib/outbox';
import { coalesce } from '@/lib/sync-tracking';
import type { Annotation } from '@/types';

const blob = (s: string) => new Blob([s]);

async function entries() {
  const all = await readOutbox();
  return all.map((e) => `${e.kind}:${e.id}:${e.op}`).sort();
}

beforeEach(async () => {
  await db.delete();
  await db.open();
});

describe('outbox: documents and pages', () => {
  it('records creating a document with its first page', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    expect(await entries()).toEqual([`document:${docId}:upsert`, `page:${page.id}:upsert`].sort());
    const pageEntry = await getOutboxEntry('page', page.id);
    expect(pageEntry?.fileChanged).toBe(true);
    expect(page.updatedAt).toBeInstanceOf(Date);
  });

  it('records a multi-page scan written in one go, pages in order', async () => {
    const docId = await createDocumentWithPages('Scan', [blob('1'), blob('2')]);
    await addPagesToDocument(docId, [blob('3')]);
    const pages = await db.pages.where('documentId').equals(docId).sortBy('pageNumber');
    expect(await Promise.all(pages.map((p) => p.processedBlob!.text()))).toEqual(['1', '2', '3']);
    expect(pages.map((p) => [p.pageNumber, p.ocrStatus, p.filter, p.corners])).toEqual([
      [1, 'pending', 'original', undefined],
      [2, 'pending', 'original', undefined],
      [3, 'pending', 'original', undefined],
    ]);
    expect((await db.documents.get(docId))?.pageCount).toBe(3);
    expect(await entries()).toEqual([`document:${docId}:upsert`, ...pages.map((p) => `page:${p.id}:upsert`)].sort());
  });

  it('records document updates and bumps nothing for thumbnail or derived-field writes', async () => {
    const docId = await createDocument('Scan', blob('img'));
    await db.outbox.clear();

    await db.documents.update(docId, { thumbnailBlob: blob('t') });
    // Derived from the pages and recomputed on every device: never synced
    await db.documents.update(docId, { searchText: 'invoice', pageCount: 2 });
    expect(await entries()).toEqual([]);

    await renameDocument(docId, 'Invoice');
    expect(await entries()).toEqual([`document:${docId}:upsert`]);
  });

  it('records page edits and stamps the page updatedAt on every write path', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const pageId = await addPageToDocument(docId, blob('img2'));
    await db.outbox.clear();
    const old = new Date('2020-01-01T00:00:00Z');
    // Untracked so the old stamp sticks
    await applyUntracked(() => db.pages.update(pageId, { updatedAt: old }));

    const expectBumped = async () => {
      const page = await db.pages.get(pageId);
      expect(page!.updatedAt.getTime()).toBeGreaterThan(old.getTime());
      await applyUntracked(() => db.pages.update(pageId, { updatedAt: old }));
    };

    // Crop / filter / rotation edits
    await updatePage(pageId, { filter: 'grayscale' });
    await expectBumped();
    let entry = await getOutboxEntry('page', pageId);
    expect(entry).toMatchObject({ op: 'upsert', fileChanged: false });

    await updatePage(pageId, { processedBlob: blob('cropped') });
    await expectBumped();
    entry = await getOutboxEntry('page', pageId);
    expect(entry?.fileChanged).toBe(true);

    await db.pages.update(pageId, { rotation: 90 });
    await expectBumped();

    // Annotations
    const note: Annotation = { id: 'a', type: 'text', x: 0, y: 0, text: 'hi', fontSize: 0.05, color: '#000' };
    await savePageAnnotations(pageId, [note]);
    await expectBumped();

    // OCR results
    await db.pages.update(pageId, { ocrStatus: 'done', ocrText: 'hello' });
    await expectBumped();

    // Reorder: deleting page 1 renumbers page 2
    const [first] = await db.pages.where('documentId').equals(docId).sortBy('pageNumber');
    await deletePage(first.id);
    const moved = await db.pages.get(pageId);
    expect(moved?.pageNumber).toBe(1);
    await expectBumped();
  });

  it('ignores writes to local-only page fields (OCR queue state, original image, orientation flag)', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    await db.outbox.clear();

    await db.pages.update(page.id, { ocrStatus: 'processing' });
    // As resetStaleOcr / requeueAllOcr do
    await db.pages.toCollection().modify({ ocrStatus: 'pending' });
    await db.pages.update(page.id, { originalBlob: blob('raw') });
    await db.pages.update(page.id, { keepOrientation: true });
    expect(await entries()).toEqual([]);
    expect((await db.pages.get(page.id))?.updatedAt).toEqual(page.updatedAt);
  });

  it('leaves a tombstone for a deleted document and each of its pages', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const p2 = await addPageToDocument(docId, blob('img2'));
    const pageIds = (await db.pages.where('documentId').equals(docId).primaryKeys()).sort();
    expect(pageIds).toContain(p2);

    await deleteDocument(docId);
    const all = await readOutbox();
    expect(all.map((e) => `${e.kind}:${e.id}:${e.op}`).sort()).toEqual(
      [`document:${docId}:delete`, ...pageIds.map((id) => `page:${id}:delete`)].sort()
    );
    // Tombstones carry no file
    expect(all.every((e) => !e.fileChanged)).toBe(true);
  });

  it('deleting the last page deletes the document too', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    await deletePage(page.id);
    expect(await entries()).toEqual([`document:${docId}:delete`, `page:${page.id}:delete`].sort());
  });

  it('records bulk deletes and clear()', async () => {
    const docId = await createDocument('Scan', blob('img'));
    await db.outbox.clear();
    await db.documents.clear();
    expect(await entries()).toEqual([`document:${docId}:delete`]);
  });
});

describe('outbox: folders, signatures, settings', () => {
  it('records folder create, rename, delete and the unfiled documents', async () => {
    const folderId = await createFolder('Tax');
    expect(await entries()).toEqual([`folder:${folderId}:upsert`]);
    await db.outbox.clear();

    await renameFolder(folderId, 'Taxes');
    expect(await entries()).toEqual([`folder:${folderId}:upsert`]);

    const docId = await createDocument('Scan', blob('img'));
    await db.documents.update(docId, { folderId });
    await db.outbox.clear();

    await deleteFolder(folderId);
    expect(await entries()).toEqual([`document:${docId}:upsert`, `folder:${folderId}:delete`].sort());
  });

  it('records signature create and delete, with the PNG as a changed file', async () => {
    await db.signatures.add({ id: 's1', blob: blob('png'), width: 10, height: 5, createdAt: new Date() });
    expect(await getOutboxEntry('signature', 's1')).toMatchObject({ op: 'upsert', fileChanged: true });
    await db.signatures.delete('s1');
    expect(await getOutboxEntry('signature', 's1')).toMatchObject({ op: 'delete', fileChanged: false });
  });

  it('records only the ocrLanguages setting', async () => {
    await updateSettings({ llmEnabled: true, openaiApiKey: 'sk-secret', openaiModel: 'gpt' });
    expect(await entries()).toEqual([]);

    await updateSettings({ ocrLanguages: ['eng', 'deu'], openaiApiKey: 'sk-other' });
    expect(await entries()).toEqual(['settings:ocrLanguages:upsert']);

    await db.settings.delete('openaiApiKey');
    expect(await entries()).toEqual(['settings:ocrLanguages:upsert']);
  });

  it('never records sync state such as the device id', async () => {
    await getDeviceId();
    expect(await entries()).toEqual([]);
  });
});

describe('outbox: coalescing and acknowledgement', () => {
  it('keeps one entry per record across repeated changes', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const first = await getOutboxEntry('document', docId);
    await renameDocument(docId, 'A');
    await addTagToDocument(docId, 'tax');
    await renameDocument(docId, 'B');

    const docEntries = (await readOutbox()).filter((e) => e.kind === 'document');
    expect(docEntries).toHaveLength(1);
    expect(docEntries[0].rev).toBe(first!.rev + 3);
    expect(docEntries[0].updatedAt).toBeGreaterThanOrEqual(first!.updatedAt);
  });

  it('keeps a pending file change when a later edit does not touch the file', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const [page] = await db.pages.where('documentId').equals(docId).toArray();
    await db.pages.update(page.id, { filter: 'bw' });
    expect((await getOutboxEntry('page', page.id))?.fileChanged).toBe(true);
  });

  it('turns an upsert into a tombstone, and a later write back into an upsert', () => {
    const up = coalesce(undefined, 'page', { id: 'p', op: 'upsert', fileChanged: true }, 100);
    const del = coalesce(up, 'page', { id: 'p', op: 'delete', fileChanged: false }, 200);
    expect(del).toMatchObject({ op: 'delete', fileChanged: false, updatedAt: 200, rev: 2 });
    const revived = coalesce(del, 'page', { id: 'p', op: 'upsert', fileChanged: false }, 300);
    expect(revived).toMatchObject({ op: 'upsert', fileChanged: false, updatedAt: 300, rev: 3 });
    // The clock never goes backwards
    expect(coalesce(revived, 'page', { id: 'p', op: 'upsert', fileChanged: false }, 50).updatedAt).toBe(300);
  });

  it('ackOutbox drops pushed entries but keeps ones changed since', async () => {
    const docId = await createDocument('Scan', blob('img'));
    const pushed = await readOutbox();
    await renameDocument(docId, 'Edited while pushing');

    await ackOutbox(pushed);
    expect(await entries()).toEqual([`document:${docId}:upsert`]);
  });

  it('rolls back the outbox entry with a failed write', async () => {
    const folderId = await createFolder('Tax');
    await db.outbox.clear();
    await expect(
      db.transaction('rw', db.folders, async () => {
        await db.folders.update(folderId, { name: 'Changed' });
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(await entries()).toEqual([]);
  });
});

describe('applyUntracked', () => {
  it('writes remote changes without queueing them or bumping updatedAt', async () => {
    const remoteTime = new Date('2026-05-05T00:00:00Z');
    await applyUntracked(async () => {
      await db.documents.put({ id: 'd', name: 'Remote', createdAt: remoteTime, updatedAt: remoteTime, pageCount: 1 });
      await db.pages.put({
        id: 'p',
        documentId: 'd',
        pageNumber: 1,
        originalBlob: blob('img'),
        processedBlob: blob('img'),
        filter: 'original',
        createdAt: remoteTime,
        updatedAt: remoteTime,
      });
      await db.pages.update('p', { ocrText: 'remote text' });
      await db.folders.put({ id: 'f', name: 'Remote', createdAt: remoteTime, updatedAt: remoteTime });
      await db.settings.put({ key: 'ocrLanguages', value: ['fra'] });
      await db.signatures.put({ id: 's', blob: blob('png'), width: 1, height: 1, createdAt: remoteTime });
      await db.folders.delete('f');
    });
    expect(await entries()).toEqual([]);
    expect((await db.pages.get('p'))?.updatedAt).toEqual(remoteTime);

    // Tracking is back for ordinary writes afterwards
    await renameDocument('d', 'Local');
    expect(await entries()).toEqual(['document:d:upsert']);
  });

  it('refuses to run inside another transaction', async () => {
    await expect(
      db.transaction('rw', db.documents, () => applyUntracked(async () => {}))
    ).rejects.toThrow('applyUntracked');
  });
});

describe('device id', () => {
  it('is created once and stays the same', async () => {
    const [a, b] = await Promise.all([getDeviceId(), getDeviceId()]);
    expect(a).toMatch(/^[\w-]{21}$/);
    expect(b).toBe(a);
    expect(await getDeviceId()).toBe(a);
    expect(await db.syncMeta.count()).toBe(1);
  });

  it('survives reopening the database', async () => {
    const id = await getDeviceId();
    db.close();
    await db.open();
    expect(await getDeviceId()).toBe(id);
  });
});
