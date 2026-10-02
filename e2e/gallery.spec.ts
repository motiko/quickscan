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
