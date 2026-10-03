import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/*
 * Passkey add → unlock → remove end to end in Chromium, with a CDP virtual authenticator
 * that supports PRF, against a local Supabase stack. Opt-in, like e2e/pairing.spec.ts:
 *
 *   npx supabase@2.119.0 start
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key> npx next dev -p 3107
 *   E2E_BASE_URL=http://localhost:3107 E2E_SUPABASE_URL=http://127.0.0.1:54321 \
 *   E2E_SUPABASE_PUBLISHABLE_KEY=<local publishable key> E2E_SUPABASE_SECRET_KEY=<local secret key> \
 *   npx playwright test e2e/passkeys.spec.ts --project="Desktop Chrome"
 *
 * The "new device" is the same tab with its IndexedDB wiped: the virtual authenticator belongs
 * to the tab, and its PRF secret can't be exported to another one, so this stands in for a
 * passkey synced by a password manager.
 */

const SUPABASE_URL = process.env.E2E_SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.E2E_SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.E2E_SUPABASE_SECRET_KEY;

test.skip(!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY, 'needs a local Supabase stack (see the comment above)');

async function signedInSession(email: string) {
  const admin = createClient(SUPABASE_URL!, SECRET_KEY!, { auth: { persistSession: false } });
  await admin.auth.admin.createUser({ email, email_confirm: true });
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (error) throw error;
  const anon = createClient(SUPABASE_URL!, PUBLISHABLE_KEY!, { auth: { persistSession: false } });
  const verified = await anon.auth.verifyOtp({ email, token: data.properties.email_otp, type: 'email' });
  if (verified.error || !verified.data.session) throw verified.error ?? new Error('no session');
  return verified.data.session;
}

async function virtualAuthenticator(page: Page): Promise<{ cdp: CDPSession; authenticatorId: string }> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

test('add a passkey after turning on sync, unlock a fresh device with it, remove it', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP virtual authenticator');
  const email = `passkey-${Date.now()}@example.com`;
  const session = await signedInSession(email);
  const context = await browser.newContext();
  const storageKey = `sb-${new URL(SUPABASE_URL!).hostname.split('.')[0]}-auth-token`;
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(session)] as const,
  );
  const page = await context.newPage();
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  await page.goto('/settings');

  // First device: turn on sync, accept the passkey suggestion.
  await page.getByRole('button', { name: 'Turn on sync', exact: true }).click();
  await page.getByLabel("I've saved my recovery key").check();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on sync', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Also add a passkey for faster unlock?' })).toBeVisible();
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Passkey added' })).toBeVisible();
  await page.getByRole('button', { name: 'OK', exact: true }).click();

  const list = page.getByRole('list', { name: 'Passkeys' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].rpId).toBe('localhost');
  expect(credentials[0].isResidentCredential).toBe(true);

  // The server row, read as the user (RLS): wrapped key plus non-secret params, id = credential id.
  const asUser = createClient(SUPABASE_URL!, PUBLISHABLE_KEY!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${session.access_token}` } },
  });
  const { data: rows, error } = await asUser.from('vault_keys').select('id, method, params');
  expect(error).toBeNull();
  const passkeyRow = rows!.find((r) => r.method === 'passkey')!;
  const credentialId = credentials[0].credentialId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  expect(passkeyRow.id).toBe(credentialId);
  expect(passkeyRow.params).toMatchObject({ method: 'passkey', credentialId, rpId: 'localhost' });
  expect(Object.keys(passkeyRow.params).sort()).toEqual(['alg', 'credentialId', 'kdf', 'method', 'prfSalt', 'rpId', 'salt', 'v']);

  // "New device": same authenticator, no local data.
  await page.goto('/manifest.webmanifest');
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('QuickScanDB');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('blocked'));
      }),
  );
  await page.goto('/settings');
  await expect(page.getByText('Unlock sync on this device')).toBeVisible();
  await page.getByRole('button', { name: 'Unlock with a passkey', exact: true }).click();
  await expect(page.getByText('Sync is on for this device')).toBeVisible();

  // Remove it.
  await list.getByRole('button', { name: 'Remove Windows passkey' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Passkeys' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a passkey', exact: true })).toBeVisible();

  await context.close();
});
