import { test, expect, type Page } from '@playwright/test';

const INVOICE_TEXT = 'ACME Widgets GmbH\nRechnung\nRechnungsdatum: 14.09.2026\nBetrag: 42,50 EUR';

// Let the app create its schema, then insert a document whose page is already recognized
async function seedRecognizedDocument(page: Page, name = 'Scan 2026-10-01 12:00') {
  await page.goto('/');
  // The gallery has queried the DB once this shows, so the schema exists
  await expect(page.getByText('No documents yet')).toBeVisible();
  await page.evaluate(
    async ({ text, name }) => {
      const blob: Blob = await new Promise((r) => {
        const c = document.createElement('canvas');
        c.width = 300;
        c.height = 400;
        c.getContext('2d')!.fillRect(0, 0, 10, 10);
        c.toBlob((b) => r(b!), 'image/jpeg');
      });
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['documents', 'pages', 'settings'], 'readwrite');
          const now = new Date();
          // Keep background OCR from touching the seeded page
          tx.objectStore('settings').put({ key: 'ocrEnabled', value: false });
          tx.objectStore('documents').put({
            id: 'd1', name, createdAt: now, updatedAt: now, pageCount: 1, nameSource: 'default',
          });
          tx.objectStore('pages').put({
            id: 'p1', documentId: 'd1', pageNumber: 1, originalBlob: blob, processedBlob: blob,
            filter: 'original', createdAt: now, ocrStatus: 'done', ocrText: text, ocrWords: [],
          });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { text: INVOICE_TEXT, name }
  );
}

test.describe('Document naming', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await page.goto('/');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const req = indexedDB.deleteDatabase('QuickScanDB');
          req.onsuccess = () => resolve();
          req.onerror = () => resolve();
        })
    );
  });

  test('suggests a name from recognized text on-device', async ({ page }) => {
    await seedRecognizedDocument(page);
    await page.goto('/doc/d1');
    await page.getByRole('button', { name: 'Suggest name' }).click();

    const input = page.locator('header input');
    await expect(input).toHaveValue('Rechnung – ACME Widgets GmbH – 2026-09-14');
    await input.press('Enter');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Rechnung – ACME Widgets GmbH – 2026-09-14');
  });

  test('uses a configured OpenAI-compatible endpoint', async ({ page }) => {
    let requestBody: { model: string; messages: { content: string }[] } | null = null;
    let authHeader: string | undefined;
    await page.route('https://llm.example.test/v1/chat/completions', async (route) => {
      requestBody = route.request().postDataJSON();
      authHeader = await route.request().headerValue('authorization') ?? undefined;
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*' },
        contentType: 'application/json',
        body: JSON.stringify({ choices: [{ message: { content: '"Rechnung ACME September 2026"' } }] }),
      });
    });

    await seedRecognizedDocument(page);
    await page.goto('/settings');
    await page.getByText('Use an AI model').click();
    await page.getByLabel('Base URL', { exact: true }).fill('https://llm.example.test/v1');
    await page.getByLabel('API key', { exact: true }).fill('sk-e2e');
    await page.getByLabel('Model', { exact: true }).fill('test/model');
    await page.getByRole('button', { name: 'Test connection' }).click();
    await expect(page.getByRole('status')).toContainText('Works!');

    await page.goto('/doc/d1');
    await page.getByRole('button', { name: 'Suggest name' }).click();
    await expect(page.locator('header input')).toHaveValue('Rechnung ACME September 2026');
    expect(requestBody!.model).toBe('test/model');
    expect(requestBody!.messages[1].content).toContain('ACME Widgets GmbH');
    expect(authHeader).toBe('Bearer sk-e2e');
  });
});
