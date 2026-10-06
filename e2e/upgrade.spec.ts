import { test, expect, type Page } from '@playwright/test';
import { hideDevOverlay } from './helpers';

/*
 * Upgrading a device that used an older QuickScan: its IndexedDB is at an older schema (Dexie
 * v6, native version 60, from the folders & tags release) with documents in it.
 *
 * The iOS start-up hang: on iPhone the upgrade to v7 waited forever for another QuickScan tab
 * that was frozen in the background and so never closed its connection, and the gallery showed
 * "Loading..." (and Settings "Checking sync…", and sign-out did nothing) indefinitely. Now the
 * app says what's going on and continues by itself once the other tab lets go.
 *
 * CI runs it in the Chromium projects; run the WebKit project (the engine of every iOS browser)
 * locally:
 *   npm run build && E2E_SERVER=prod npx playwright test e2e/upgrade.spec.ts
 *
 * Seeded records carry no Blobs (Playwright's WebKit can't store Blobs in IndexedDB), except in
 * the v8 image move test, which skips WebKit.
 */

/**
 * Create QuickScanDB as the v6 app did, with one document, from a page of the same origin that
 * isn't the app. With `hold`, that page keeps its connection open and, like a frozen tab,
 * never closes it when asked.
 */
async function seedV6(page: Page, { hold = false, images = false } = {}) {
  await page.goto('/manifest.webmanifest');
  await page.evaluate(
    async ({ hold, images }) => {
      // Images were Blobs on the records until v8
      let image: Blob | undefined;
      if (images) {
        const canvas = new OffscreenCanvas(30, 40);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#c33';
        ctx.fillRect(0, 0, 30, 40);
        image = await canvas.convertToBlob({ type: 'image/png' });
      }
      const withImage = (fields: Record<string, Blob | undefined>) => (image ? fields : {});
      return new Promise<void>((resolve, reject) => {
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
          folders.put({ id: 'f1', name: 'Taxes', createdAt: now, updatedAt: now });
          docs.put({
            id: 'd1', name: 'Old Lease', createdAt: now, updatedAt: now, pageCount: 1, folderId: 'f1', tags: ['home'],
            ...withImage({ thumbnailBlob: image }),
          });
          pages.put({
            id: 'p1', documentId: 'd1', pageNumber: 1, filter: 'original', createdAt: now, ocrStatus: 'done', ocrText: 'lease',
            ...withImage({ originalBlob: image, processedBlob: image }),
          });
          req.transaction!.objectStore('settings').put({ key: 'ocrLanguages', value: ['eng'] });
        };
        req.onsuccess = () => {
          if (hold) (window as unknown as { held: IDBDatabase }).held = req.result;
          else req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      });
    },
    { hold, images }
  );
}

function nativeVersion(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          resolve(req.result.version);
          req.result.close();
        };
      })
  );
}

test.describe('Upgrading an older database', () => {
  test.beforeEach(async ({ page }) => {
    await hideDevOverlay(page);
  });

  test('upgrades a v6 database with documents and shows them', async ({ page }) => {
    await seedV6(page);
    await page.goto('/');
    await expect(page.getByText('Old Lease')).toBeVisible();
    await expect(page.getByTestId('database-gate')).toHaveCount(0);
    expect(await nativeVersion(page)).toBe(80);
  });

  test('moves stored images into their own table and still shows them (v8, #89)', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await seedV6(page, { images: true });
    await page.goto('/');
    const thumbnail = page.locator('a[href*="d1"] img');
    await expect(thumbnail).toBeVisible();
    await expect.poll(() => thumbnail.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(30);

    const stored = await page.evaluate(
      () =>
        new Promise<{ page: Record<string, unknown>; doc: Record<string, unknown>; images: number }>((resolve) => {
          const req = indexedDB.open('QuickScanDB');
          req.onsuccess = () => {
            const tx = req.result.transaction(['pages', 'documents', 'images']);
            const out: Record<string, unknown> = {};
            tx.objectStore('pages').get('p1').onsuccess = (e) => (out.page = (e.target as IDBRequest).result);
            tx.objectStore('documents').get('d1').onsuccess = (e) => (out.doc = (e.target as IDBRequest).result);
            tx.objectStore('images').count().onsuccess = (e) => (out.images = (e.target as IDBRequest).result);
            tx.oncomplete = () => {
              req.result.close();
              resolve(out as never);
            };
          };
        })
    );
    expect(stored.page.processedBlob).toBeUndefined();
    expect(stored.page.originalBlob).toBeUndefined();
    expect(stored.page.processedImageId).toBe(stored.page.originalImageId);
    expect(stored.doc.thumbnailBlob).toBeUndefined();
    expect(stored.doc.thumbnailId).toEqual(expect.any(String));
    expect(stored.images).toBe(2);
  });

  test('says when another tab blocks the upgrade, and continues once it closes', async ({ page, context }) => {
    const oldTab = await context.newPage();
    await seedV6(oldTab, { hold: true });

    await page.goto('/');
    const gate = page.getByTestId('database-gate');
    await expect(gate).toBeVisible();
    await expect(gate).toHaveAttribute('data-state', 'blocked');
    await expect(gate.getByText('QuickScan was updated')).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Reload' })).toBeVisible();

    await oldTab.evaluate(() => (window as unknown as { held: IDBDatabase }).held.close());
    await expect(page.getByText('Old Lease')).toBeVisible();
    await expect(gate).toHaveCount(0);
  });

  test('an open tab of the new version is told to reload when a newer one upgrades', async ({ page, context }) => {
    await seedV6(page);
    await page.goto('/');
    await expect(page.getByText('Old Lease')).toBeVisible();

    // A "future version" opens the database at a higher version from another tab
    const newer = await context.newPage();
    await newer.goto('/manifest.webmanifest');
    const result = await newer.evaluate(
      () =>
        new Promise<string>((resolve) => {
          const req = indexedDB.open('QuickScanDB', 90);
          req.onblocked = () => resolve('blocked');
          req.onsuccess = () => {
            req.result.close();
            resolve('upgraded');
          };
        })
    );
    expect(result).toBe('upgraded');
    await expect(page.getByTestId('database-gate')).toHaveAttribute('data-state', 'outdated');
  });

  for (const [name, locks] of [
    ['missing', 'missing'],
    ['never granting', 'stuck'],
  ] as const) {
    test(`starts with Web Locks ${name}`, async ({ page }) => {
      await page.addInitScript((locks) => {
        const value = locks === 'missing' ? undefined : { request: () => new Promise(() => {}) };
        Object.defineProperty(Navigator.prototype, 'locks', { get: () => value, configurable: true });
      }, locks);
      await seedV6(page);
      await page.goto('/');
      await expect(page.getByText('Old Lease')).toBeVisible();
      await page.goto('/settings');
      await expect(page.getByText('Text recognition (OCR)', { exact: false })).toBeVisible();
    });
  }
});
