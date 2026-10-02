import { test, expect } from '@playwright/test';
import { resetDatabase, seedDocument } from './helpers';

const INVOICE_TEXT = 'ACME Widgets GmbH\nRechnung\nRechnungsdatum: 14.09.2026\nBetrag: 42,50 EUR';

test.describe('Document naming', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await resetDatabase(page);
  });

  test('suggests a name from recognized text on-device', async ({ page }) => {
    await seedDocument(page, { text: INVOICE_TEXT });
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

    await seedDocument(page, { text: INVOICE_TEXT });
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
