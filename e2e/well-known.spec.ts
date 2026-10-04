import { test, expect } from '@playwright/test';

// The iOS app may use this site's passkeys only if Apple can read this file as JSON listing
// the app (docs/native/m0-spike.md). A redirect, HTML or a missing app id breaks passkeys there.
test('apple-app-site-association lists the iOS app as JSON, without a redirect', async ({ request }) => {
  const response = await request.get('/.well-known/apple-app-site-association', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toEqual({ webcredentials: { apps: ['RWNFPY7RQK.app.quickscan'] } });
});
