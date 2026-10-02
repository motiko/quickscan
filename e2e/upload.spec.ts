import { test, expect, type Page } from '@playwright/test';
import { resetDatabase, hideDevOverlay } from './helpers';

/** Render text into an image in the browser and return it as an upload payload. */
async function textImage(page: Page, name: string, lines: string[], mimeType = 'image/png') {
  const base64 = await page.evaluate(
    async ({ lines, mimeType }) => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 900;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 56px Arial';
      lines.forEach((line, i) => ctx.fillText(line, 80, 160 + i * 110));
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), mimeType));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    },
    { lines, mimeType }
  );
  return { name, mimeType, buffer: Buffer.from(base64, 'base64') };
}

async function disableOcr(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          const tx = req.result.transaction('settings', 'readwrite');
          tx.objectStore('settings').put({ key: 'ocrEnabled', value: false });
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      })
  );
}

test.describe('File upload', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await hideDevOverlay(page);
    await resetDatabase(page);
    await page.goto('/');
    await expect(page.getByText('No documents yet')).toBeVisible();
  });

  test('imports a batch of images, one document each, and reports unsupported files', async ({ page }) => {
    await disableOcr(page);
    const files = [
      await textImage(page, 'Lease Agreement.png', ['Lease']),
      await textImage(page, 'IMG_0042.jpg', ['Photo'], 'image/jpeg'),
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') },
    ];

    await page.getByTestId('upload-input').setInputFiles(files);

    await expect(page.getByRole('heading', { name: 'Lease Agreement' })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Upload \d{4}-\d{2}-\d{2}/ })).toBeVisible();
    await expect(page.getByText('1 file couldn’t be imported')).toBeVisible();
    await expect(page.getByText('notes.txt — Unsupported file type')).toBeVisible();

    await page.getByRole('button', { name: 'Dismiss import errors' }).click();
    await expect(page.getByText('1 file couldn’t be imported')).toHaveCount(0);
  });

  test('recognizes text in uploaded images so they become searchable', async ({ page }) => {
    // Tesseract downloads its language data on first use
    test.setTimeout(120_000);
    const files = [
      await textImage(page, 'first.png', ['ZEPPELIN INVOICE', 'Total 42.00']),
      await textImage(page, 'second.png', ['QUARTERLY REPORT', 'Revenue']),
    ];

    await page.getByTestId('upload-input').setInputFiles(files);

    await expect(page.getByRole('heading', { name: 'first' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'second' })).toBeVisible();
    // Pages wait their turn for OCR, so the processing indicator shows up first
    await expect(page.getByText(/Recognizing text · \d pages? left/)).toBeVisible();
    await expect(page.getByText('Processing').first()).toBeVisible();

    await expect(page.getByText(/Recognizing text/)).toHaveCount(0, { timeout: 100_000 });
    await expect(page.getByText('Processing')).toHaveCount(0);

    const search = page.getByLabel('Search documents');
    await search.fill('zeppelin');
    await expect(page.getByRole('heading', { name: 'first' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'second' })).toHaveCount(0);

    await search.fill('quarterly');
    await expect(page.getByRole('heading', { name: 'second' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'first' })).toHaveCount(0);
  });
});
