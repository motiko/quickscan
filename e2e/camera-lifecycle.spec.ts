import { test, expect, type Page } from '@playwright/test';

// Record every stream the app opens so we can assert the camera is released
async function trackStreams(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      w.__streams.push(stream);
      return stream;
    };
  });
}

function liveTrackCount(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __streams: MediaStream[] }).__streams
      .flatMap((s) => s.getTracks())
      .filter((t) => t.readyState === 'live').length
  );
}

test.describe('Camera lifecycle', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'webkit', 'Camera emulation not supported in WebKit');
  });

  test('releases the camera after capturing a photo', async ({ page }) => {
    await trackStreams(page);
    await page.goto('/');
    await page.getByLabel('Scan new document').click();
    await expect(page).toHaveURL(/\/scan/);

    const applyCrop = page.getByRole('button', { name: /Apply Crop/ });
    const shutter = page.getByLabel('Take photo');
    // Auto-capture may finish before we look, so wait for either an enabled shutter or the crop step
    await expect(async () => {
      expect((await applyCrop.isVisible()) || (await shutter.isEnabled())).toBe(true);
    }).toPass({ timeout: 10000 });
    expect(
      await page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length)
    ).toBeGreaterThan(0);

    if (!(await applyCrop.isVisible())) await shutter.click();
    await expect(applyCrop).toBeVisible();

    await expect.poll(() => liveTrackCount(page)).toBe(0);
  });

  test('releases the camera when leaving the scanner right away', async ({ page }) => {
    await trackStreams(page);
    await page.goto('/');
    await page.getByLabel('Scan new document').click();
    await expect(page).toHaveURL(/\/scan/);
    // Leave before getUserMedia has necessarily resolved
    await page.getByLabel('Close camera').click();
    await expect(page).toHaveURL(/\/$/);

    // Give any in-flight getUserMedia time to resolve, then expect it to have been stopped
    await page.waitForTimeout(1500);
    expect(await liveTrackCount(page)).toBe(0);
  });
});
