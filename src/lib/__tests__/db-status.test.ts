import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import type Dexie from 'dexie';

/*
 * The iOS start-up hang: a schema upgrade waits for every other connection to close, and a
 * frozen tab never closes its own. The app must say so (and carry on once it can) instead of
 * showing "Loading..." forever, and must not hold a connection while hidden.
 *
 * The tests share one database and run in order.
 */

/** Open QuickScanDB as an old app version (Dexie v6 is native version 60) that never lets go. */
function openUnresponsiveV6(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('QuickScanDB', 60);
    req.onupgradeneeded = () => {
      const db = req.result;
      const docs = db.createObjectStore('documents', { keyPath: 'id' });
      for (const i of ['name', 'createdAt', 'updatedAt', 'folderId']) docs.createIndex(i, i);
      docs.createIndex('tags', 'tags', { multiEntry: true });
      const pages = db.createObjectStore('pages', { keyPath: 'id' });
      pages.createIndex('documentId', 'documentId');
      pages.createIndex('[documentId+pageNumber]', ['documentId', 'pageNumber']);
      pages.createIndex('ocrStatus', 'ocrStatus');
      db.createObjectStore('settings', { keyPath: 'key' });
      db.createObjectStore('signatures', { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      const folders = db.createObjectStore('folders', { keyPath: 'id' });
      for (const i of ['name', 'createdAt', 'updatedAt']) folders.createIndex(i, i);
      const now = new Date();
      docs.put({ id: 'd1', name: 'Old document', createdAt: now, updatedAt: now, pageCount: 1 });
    };
    // No onversionchange handler: like a suspended tab, it never closes when asked
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function fakeDexie(open: () => Promise<unknown>): Dexie {
  return { isOpen: () => false, open } as unknown as Dexie;
}

describe('database status', () => {
  it('reports a blocked upgrade, then upgrades and becomes ready once the old connection closes', async () => {
    const old = await openUnresponsiveV6();
    const { db } = await import('@/lib/db');
    const status = await import('@/lib/db-status');

    const opened = status.openDatabase(db);
    await vi.waitFor(() => expect(status.getDatabaseStatus().state).toBe('blocked'));

    old.close();
    await opened;
    expect(status.getDatabaseStatus().state).toBe('ready');
    expect(db.verno).toBe(7);
    expect((await db.documents.get('d1'))?.name).toBe('Old document');
    expect(await db.outbox.count()).toBe(1);
  });

  it('lets go of the database while hidden, so it never blocks a later upgrade, and reopens when shown', async () => {
    const { db } = await import('@/lib/db');
    const status = await import('@/lib/db-status');
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
    const win = new EventTarget();
    const stop = status.releaseWhileHidden(db, doc as unknown as Document, win as unknown as Window);

    doc.visibilityState = 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(db.isOpen()).toBe(false);

    // A later version's upgrade can start without this connection being asked to close
    // (aborted here, so the database stays at this version)
    const versionchange = vi.fn();
    db.on('versionchange', versionchange);
    const upgrade = await new Promise<string>((resolve) => {
      const req = indexedDB.open('QuickScanDB', 75);
      req.onblocked = () => resolve('blocked');
      req.onupgradeneeded = () => req.transaction!.abort();
      req.onerror = () => resolve('upgrade started');
    });
    expect(upgrade).toBe('upgrade started');

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(db.isOpen()).toBe(true));
    expect(await db.documents.count()).toBe(1);

    // pagehide (back/forward cache) releases it too, and queries reopen on demand
    win.dispatchEvent(new Event('pagehide'));
    expect(db.isOpen()).toBe(false);
    expect(await db.documents.count()).toBe(1);
    expect(versionchange).not.toHaveBeenCalled();
    db.on('versionchange').unsubscribe(versionchange);
    stop();
  });

  it('marks this tab outdated when a newer version upgrades the database, without blocking it', async () => {
    const { db } = await import('@/lib/db');
    const status = await import('@/lib/db-status');
    await status.openDatabase(db);
    expect(db.isOpen()).toBe(true);

    const upgraded = await new Promise<string>((resolve) => {
      const req = indexedDB.open('QuickScanDB', 80);
      req.onblocked = () => resolve('blocked');
      req.onsuccess = () => {
        req.result.close();
        resolve('upgraded');
      };
    });
    expect(upgraded).toBe('upgraded');
    expect(status.getDatabaseStatus().state).toBe('outdated');
  });

  it('reports a slow open, and an open that fails, instead of waiting forever', async () => {
    vi.resetModules();
    const status = await import('@/lib/db-status');
    let finish!: () => void;
    const slow = status.openDatabase(fakeDexie(() => new Promise<void>((r) => (finish = r))), 20);
    await vi.waitFor(() => expect(status.getDatabaseStatus().state).toBe('slow'));
    finish();
    await slow;
    expect(status.getDatabaseStatus().state).toBe('ready');

    status.resetDatabaseStatus();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await status.openDatabase(fakeDexie(() => Promise.reject(new DOMException('Disk full', 'QuotaExceededError'))));
    expect(status.getDatabaseStatus()).toEqual({ state: 'error', message: 'QuotaExceededError: Disk full' });
  });
});
