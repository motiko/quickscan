import { test, expect } from '@playwright/test';
import { readRecord, resetDatabase, seedDocument } from './helpers';

test.describe('Escape and confirm dialogs', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await resetDatabase(page);
    await seedDocument(page, { text: 'Hello' });
  });

  test('Escape closes the topmost layer first', async ({ page }) => {
    await page.goto('/doc/d1');
    await page.getByAltText('Page 1').click();
    const viewerClose = page.getByRole('button', { name: 'Close', exact: true });
    await page.getByRole('button', { name: 'Show page text' }).click();
    const sheet = page.getByRole('dialog', { name: 'Recognized text' });
    await expect(sheet).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
    await expect(viewerClose).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByText('Page 1 of 1')).not.toBeVisible();
  });

  test('deleting a document asks in an in-app dialog', async ({ page }) => {
    page.on('dialog', () => {
      throw new Error('Native browser dialogs must not be used');
    });
    await page.goto('/doc/d1');
    const deleteButton = page.getByRole('button', { name: 'Delete', exact: true });

    await deleteButton.click();
    const dialog = page.getByRole('alertdialog', { name: 'Delete this document?' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible();

    await deleteButton.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect(await readRecord(page, 'documents', 'd1')).toBeTruthy();

    await deleteButton.click();
    await dialog.getByRole('button', { name: 'Delete' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByText('No documents yet')).toBeVisible();
  });

  test('re-running recognition on all pages asks first', async ({ page }) => {
    await page.goto('/settings');
    await page.getByRole('button', { name: 'Re-run recognition on all pages' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Re-run recognition on all pages?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Re-run' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    expect((await readRecord<{ ocrStatus: string }>(page, 'pages', 'p1')).ocrStatus).toBe('done');
  });
});

test('Escape leaves the camera', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Camera emulation not supported in WebKit');
  await page.goto('/');
  await page.getByLabel('Scan new document').click();
  await expect(page).toHaveURL(/\/scan/);
  await expect(page.getByLabel('Take photo')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/scan/);
});
