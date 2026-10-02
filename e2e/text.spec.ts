import { test, expect } from '@playwright/test';
import { readRecord, resetDatabase, seedDocument } from './helpers';

const TEXT = 'ACME Widgets GmbH\nRechnung';

test.describe('Recognized text', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await resetDatabase(page);
    await seedDocument(page, { text: TEXT });
    await page.goto('/doc/d1');
  });

  test('shows the text of the whole document', async ({ page }) => {
    await page.getByRole('button', { name: 'Show text of all pages' }).click();
    const sheet = page.getByRole('dialog', { name: 'Recognized text' });
    await expect(sheet.getByRole('heading', { name: 'Text · All pages' })).toBeVisible();
    await expect(sheet.locator('pre')).toHaveText(TEXT);
    await expect(sheet.getByRole('button', { name: 'Copy text' })).toBeVisible();
    // Background OCR is off in the seeded settings, so there's nothing to retry with
    await expect(sheet.getByRole('button', { name: 'Retry text recognition' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Close' }).click();
    await expect(sheet).not.toBeVisible();
  });

  test('shows the text of a single page', async ({ page }) => {
    await page.getByAltText('Page 1').click();
    await page.getByRole('button', { name: 'Show page text' }).click();
    const sheet = page.getByRole('dialog', { name: 'Recognized text' });
    await expect(sheet.getByRole('heading', { name: 'Text · Page 1' })).toBeVisible();
    await expect(sheet.locator('pre')).toHaveText(TEXT);
  });
});

test.describe('Text recognition info', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await resetDatabase(page);
    await seedDocument(page, {
      text: TEXT,
      ocrEnabled: true,
      ocrInfo: { languages: ['eng'], detectedLanguage: 'deu', confidence: 87 },
    });
    await page.goto('/doc/d1');
  });

  test('shows how the text was recognized', async ({ page }) => {
    await page.getByRole('button', { name: 'Show text of all pages' }).click();
    const sheet = page.getByRole('dialog', { name: 'Recognized text' });
    await expect(sheet.getByRole('button', { name: 'Retry text recognition' })).toBeEnabled();

    await sheet.getByRole('button', { name: 'Text info' }).click();
    const info = sheet.getByRole('region', { name: 'Text recognition info' });
    await expect(info).toContainText('Tesseract');
    await expect(info).toContainText('English');
    await expect(info).toContainText('87%');
    await expect(info).toContainText("German isn't selected for text recognition.");

    await sheet.getByRole('button', { name: 'Text info' }).click();
    await expect(info).not.toBeVisible();
  });

  test('adds a detected language to the OCR languages', async ({ page }) => {
    await page.getByAltText('Page 1').click();
    await page.getByRole('button', { name: 'Show page text' }).click();
    const sheet = page.getByRole('dialog', { name: 'Recognized text' });
    await sheet.getByRole('button', { name: 'Text info' }).click();
    await sheet.getByRole('button', { name: 'Add & retry' }).click();

    await expect
      .poll(async () => (await readRecord<{ value: string[] }>(page, 'settings', 'ocrLanguages'))?.value)
      .toEqual(['eng', 'deu']);
  });
});
