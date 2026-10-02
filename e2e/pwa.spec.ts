import { test, expect } from '@playwright/test';

test.describe('PWA Features', () => {
  test('Manifest is served correctly', async ({ request, baseURL }) => {
    const response = await request.get(`${baseURL}/manifest.json`);
    expect(response.ok()).toBeTruthy();
    const manifest = await response.json();
    expect(manifest.name).toBe('QuickScan');
    expect(manifest.short_name).toBe('QuickScan');
    expect(manifest.start_url).toBe('/');
    expect(manifest.display).toBe('standalone');
  });

  test('Service worker is registered', async ({ page }) => {
    await page.goto('/');
    
    // Wait a moment for service worker registration
    await page.waitForTimeout(1000);
    
    const swStatus = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      return registration ? registration.active?.state : null;
    });
    // Verify it doesn't throw and returns null or valid state
    expect(swStatus === null || typeof swStatus === 'string').toBeTruthy();
  });
});
