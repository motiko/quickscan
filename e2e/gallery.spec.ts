import { test, expect } from '@playwright/test';

test.describe('Document Gallery', () => {
  test.beforeEach(async ({ page }) => {
    // Clear IndexedDB before each test to start with empty state
    await page.goto('/');
    await page.evaluate(async () => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('QuickScanDB');
        req.onsuccess = () => resolve();
        req.onerror = () => reject();
      });
    });
    // Reload page to reflect empty state
    await page.reload();
  });

  test('Shows empty state when no documents exist', async ({ page }) => {
    await expect(page.getByText('No documents yet')).toBeVisible();
    await expect(page.getByText('Scan your first document to get started')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Start Scanning' })).toBeVisible();
  });

  // Depending on how multi-select is implemented, we might test more here. 
  // For now, ensuring basic gallery presence is enough for a smoke test.
});

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(async () => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('QuickScanDB');
        req.onsuccess = () => resolve();
        req.onerror = () => reject();
      });
    });
    await page.reload();
  });

  test('OCR language choice persists across reloads', async ({ page }) => {
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    const english = page.getByRole('button', { name: 'English' });
    const german = page.getByRole('button', { name: 'German' });
    await expect(english).toHaveAttribute('aria-pressed', 'true');
    await expect(german).toHaveAttribute('aria-pressed', 'false');

    await german.click();
    await expect(german).toHaveAttribute('aria-pressed', 'true');

    await page.reload();
    await expect(page.getByRole('button', { name: 'German' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  });
});
