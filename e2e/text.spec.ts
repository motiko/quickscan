import { test, expect } from '@playwright/test';
import { resetDatabase, seedDocument } from './helpers';

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
