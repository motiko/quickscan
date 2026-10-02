import { test, expect } from '@playwright/test';

test.describe('Scan Flow', () => {
  test('Complete document scanning flow', async ({ page, browserName }) => {
    page.on('console', msg => console.log('BROWSER CONSOLE:', msg.text()));
    test.skip(browserName === 'webkit', 'Camera emulation not supported in WebKit');

    // Navigate to home page
    await page.goto('/');
    await expect(page).toHaveTitle(/QuickScan/);

    // Click scan button (the fixed bottom right button or the 'Start Scanning' empty state button)
    // We try to click the fixed button using its generic SVG aria-label or just router push button
    await page.getByLabel('Scan new document').click();

    // Verify we arrived at /scan
    await expect(page).toHaveURL(/.*\/scan/);

    // Wait for camera view to initialize (should show "Align document inside frame" or "Ready to capture!" or a button)
    // Wait a brief moment to see what's rendered
    await page.waitForTimeout(1000);
    const bodyText = await page.locator('body').innerText();
    console.log('Body text on /scan:\n', bodyText);

    const applyCropButton = page.getByRole('button', { name: /Apply Crop/ });
    const shutterButton = page.getByLabel('Take photo');

    // If auto-captured during stabilization, crop overlay is already visible
    if (!(await applyCropButton.isVisible())) {
      await expect(shutterButton).toBeVisible({ timeout: 5000 });
      await shutterButton.click();
    }

    // Crop overlay appears
    await expect(applyCropButton).toBeVisible();

    // Apply crop
    await applyCropButton.click();

    // Review phase shows the processed image
    const doneButton = page.getByRole('button', { name: /Done/ });
    await expect(doneButton).toBeVisible();

    // The filter selection should be visible
    const grayscaleFilter = page.getByText('Grayscale', { exact: true });
    await expect(grayscaleFilter).toBeVisible();
    await grayscaleFilter.click();

    // Save creates a document
    await doneButton.click();

    // Redirects to document page (url should contain /doc/)
    await expect(page).toHaveURL(/.*\/doc\/.+/);

    // Verify document page loaded by checking for some generic document viewer elements or just back button
    const backButton = page.getByRole('button').filter({ hasText: 'Back' }).or(page.getByLabel('Go back'));
    if (await backButton.count() > 0) {
       await backButton.click();
    } else {
       await page.goto('/');
    }

    // Document appears in gallery
    await expect(page).toHaveURL(/.*localhost:3000\/?$/);
    // There should be at least one document card
    // The empty state shouldn't be there
    await expect(page.getByText('No documents yet')).not.toBeVisible();
  });
});
