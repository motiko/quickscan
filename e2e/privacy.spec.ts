import { test, expect } from '@playwright/test';
import { hideDevOverlay } from './helpers';

// The stores link to /privacy; the app links to it from Settings
test('the privacy policy opens from Settings and fits a phone screen', async ({ page }) => {
  await hideDevOverlay(page);
  await page.goto('/settings');
  await page.getByRole('link', { name: 'Privacy policy' }).click();
  await expect(page).toHaveURL(/\/privacy$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy policy' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Account and sync (optional)' })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('link', { name: 'Back to settings' }).click();
  await expect(page).toHaveURL(/\/settings$/);
});
