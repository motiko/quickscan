import { test, expect, type Page } from '@playwright/test';
import { resetDatabase, hideDevOverlay, seedDocument } from './helpers';

/** Paste a freshly drawn PNG, the way a copied screenshot arrives (`image.png`). */
async function pasteImage(page: Page) {
  await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 600;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, c.width, c.height);
    const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
    const data = new DataTransfer();
    data.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
}

test.describe('Paste from clipboard', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await hideDevOverlay(page);
    await resetDatabase(page);
  });

  test('pasting an image in the gallery creates a document', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText('No documents yet')).toBeVisible();

    await pasteImage(page);

    await expect(page.getByRole('heading', { name: /^Upload \d{4}-\d{2}-\d{2}/ })).toBeVisible();
  });

  test('pasting an image inside a document adds a page', async ({ page }) => {
    await seedDocument(page);
    await page.goto('/doc/d1');
    await expect(page.getByText('1 page •')).toBeVisible();

    await pasteImage(page);

    await expect(page.getByText('2 pages •')).toBeVisible();
    await expect(page.getByAltText('Page 2')).toBeVisible();
  });
});
