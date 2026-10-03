import { defineConfig, devices } from '@playwright/test';

/**
 * Where the app under test runs. Specs navigate with relative paths and check URLs relative to
 * it, so any port works (e.g. a server built with Supabase env vars for e2e/pairing.spec.ts).
 */
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const port = new URL(baseURL).port || '3000';

/**
 * `E2E_SERVER=prod` serves the existing production build (`npm run build` first), which is what
 * CI tests: per-request CSP nonces and the service worker as shipped. Default: `next dev`.
 */
const serverCommand =
  process.env.E2E_SERVER === 'prod' ? `npx next start -p ${port}` : `npm run dev -- -p ${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'iPhone Camera (Chromium)',
      use: {
        ...devices['iPhone 15'],
        browserName: 'chromium',
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
        permissions: ['camera'],
      },
    },
    {
      name: 'iPhone Safari (WebKit)',
      use: {
        ...devices['iPhone 15'],
        browserName: 'webkit',
      },
    },
    {
      name: 'Desktop Chrome',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
        permissions: ['camera'],
      },
    },
  ],
  webServer: {
    command: serverCommand,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
  },
});
