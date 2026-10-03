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
 * Runs in every project (Chromium and WebKit) against the dev server like the other specs:
 *   npx playwright test e2e/upgrade.spec.ts
 * or against a production build:
 *   npm run build && npx next start -p 3123
 *   E2E_BASE_URL=http://localhost:3123 npx playwright test e2e/upgrade.spec.ts
 *
 * Seeded records carry no Blobs: Playwright's WebKit can't store Blobs in IndexedDB.
 */

/**
 * Create QuickScanDB as the v6 app did, with one document, from a page of the same origin that
 * isn't the app. With `hold`, that page keeps its connection open and, like a frozen tab,
 * never closes it when asked.
 */
async function seedV6(page: Page, { hold = false } = {}) {
  await page.goto('/manifest.webmanifest');
  await page.evaluate(
    (hold) =>
      new Promise<void>((resolve, reject) => {
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
          docs.put({ id: 'd1', name: 'Old Lease', createdAt: now, updatedAt: now, pageCount: 1, folderId: 'f1', tags: ['home'] });
          pages.put({ id: 'p1', documentId: 'd1', pageNumber: 1, filter: 'original', createdAt: now, ocrStatus: 'done', ocrText: 'lease' });
          req.transaction!.objectStore('settings').put({ key: 'ocrLanguages', value: ['eng'] });
        };
        req.onsuccess = () => {
          if (hold) (window as unknown as { held: IDBDatabase }).held = req.result;
          else req.result.close();
          resolve();
        };
        req.onerror = () => reject(req.error);
      }),
    hold
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
    expect(await nativeVersion(page)).toBe(70);
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
          const req = indexedDB.open('QuickScanDB', 80);
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
