import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, chromium, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { createClient } from '@supabase/supabase-js';

/*
 * QR pairing end to end, two browser contexts against a local Supabase stack. Opt-in, since it
 * needs Docker and a dev server built for it:
 *
 *   npx supabase@2.119.0 start
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 \
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<local publishable key> \
 *   NEXT_PUBLIC_E2E_HOOKS=1 npx next dev -p 3107
 *   E2E_BASE_URL=http://localhost:3107 E2E_SUPABASE_URL=http://127.0.0.1:54321 \
 *   E2E_SUPABASE_PUBLISHABLE_KEY=<local publishable key> E2E_SUPABASE_SECRET_KEY=<local secret key> \
 *   npx playwright test e2e/pairing.spec.ts --project="Desktop Chrome"
 *
 * The keys are the local stack's (`npx supabase status`), never a real project's. The camera
 * isn't used for decoding: NEXT_PUBLIC_E2E_HOOKS=1 builds expose the scanned-text entry point
 * (window.__quickscanScanPairingCode) and the QR text, both compiled out of normal builds.
 */

const SUPABASE_URL = process.env.E2E_SUPABASE_URL;
const PUBLISHABLE_KEY = process.env.E2E_SUPABASE_PUBLISHABLE_KEY;
const SECRET_KEY = process.env.E2E_SUPABASE_SECRET_KEY;

test.skip(!SUPABASE_URL || !PUBLISHABLE_KEY || !SECRET_KEY, 'needs a local Supabase stack (see the comment above)');
test.describe.configure({ mode: 'serial' });

/** A confirmed user with a fresh session, made with the local stack's secret key. */
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

/** A device: its own browser context (own IndexedDB and localStorage), signed in. */
async function device(browser: Browser, email: string): Promise<{ context: BrowserContext; page: Page }> {
  const session = await signedInSession(email);
  const context = await browser.newContext({ permissions: ['camera'] });
  const storageKey = `sb-${new URL(SUPABASE_URL!).hostname.split('.')[0]}-auth-token`;
  await context.addInitScript(
    ([key, value]) => {
      if (!localStorage.getItem(key)) localStorage.setItem(key, value);
    },
    [storageKey, JSON.stringify(session)] as const,
  );
  const page = await context.newPage();
  await page.goto('/settings');
  return { context, page };
}

async function turnOnSync(page: Page) {
  await page.getByRole('button', { name: 'Turn on sync', exact: true }).click();
  await page.getByLabel("I've saved my recovery key").check();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on sync', exact: true }).click();
  await expect(page.getByText('Sync is on for this device')).toBeVisible();
}

async function showPairingCode(page: Page) {
  await expect(page.getByText('Unlock sync on this device')).toBeVisible();
  await page.getByRole('button', { name: 'Scan from another device', exact: true }).click();
  const code = page.getByTestId('pairing-code');
  await expect(code).toHaveText(/^qs1:/);
  return {
    code: (await code.textContent())!,
    fingerprint: (await page.getByRole('dialog').getByTestId('pairing-fingerprint').textContent())!,
  };
}

async function scan(page: Page, code: string) {
  await page.getByRole('button', { name: 'Add a device', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Add a device' })).toBeVisible();
  await page.waitForFunction(() => typeof window.__quickscanScanPairingCode === 'function');
  await page.evaluate((text) => window.__quickscanScanPairingCode!(text), code);
}

test('a new device unlocks by scanning from an unlocked one', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'camera permission for the scanner');
  const email = `pair-${Date.now()}@example.com`;
  const phone = await device(browser, email);
  await turnOnSync(phone.page);

  const laptop = await device(browser, email);
  const { code, fingerprint } = await showPairingCode(laptop.page);
  await expect(laptop.page.getByText(/expires in [45]:\d\d/)).toBeVisible();

  await scan(phone.page, code);
  await expect(phone.page.getByRole('dialog').getByTestId('pairing-fingerprint')).toHaveText(fingerprint);

  await expect(laptop.page.getByRole('heading', { name: 'Sync is on for this device' })).toBeVisible({
    timeout: 10_000,
  });
  await laptop.page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(laptop.page.getByText('Sync is on for this device')).toBeVisible();

  // The request is gone and the same code can't be answered again.
  await phone.page.getByRole('button', { name: 'Done', exact: true }).click();
  await scan(phone.page, code);
  await expect(phone.page.getByText("This code isn't valid for your account or has expired")).toBeVisible();

  await phone.context.close();
  await laptop.context.close();
});

test('an unlocked device refuses a code from another account', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'camera permission for the scanner');
  const stamp = Date.now();
  const victim = await device(browser, `victim-${stamp}@example.com`);
  await turnOnSync(victim.page);

  // The attacker has their own account with sync on, and a second device of theirs shows a code.
  const attackerPhone = await device(browser, `attacker-${stamp}@example.com`);
  await turnOnSync(attackerPhone.page);
  const attackerNew = await device(browser, `attacker-${stamp}@example.com`);
  const { code } = await showPairingCode(attackerNew.page);

  await scan(victim.page, code);
  await expect(victim.page.getByText("This code isn't valid for your account or has expired")).toBeVisible();
  // Nothing was sealed into the attacker's request: it's still waiting.
  await attackerNew.page.waitForTimeout(2_500);
  await expect(attackerNew.page.getByText(/Waiting for your other device/)).toBeVisible();

  await attackerNew.page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(attackerNew.page.getByRole('dialog')).toHaveCount(0);

  for (const d of [victim, attackerPhone, attackerNew]) await d.context.close();
});

/** A one-frame Y4M video of `text` as a QR code, for Chromium's fake camera. */
async function qrVideo(text: string): Promise<string> {
  const { encode } = await import('uqr');
  const qr = encode(text, { ecc: 'M', border: 4 });
  const [w, h] = [640, 480];
  const scale = Math.floor(440 / qr.size);
  const [ox, oy] = [Math.floor((w - qr.size * scale) / 2), Math.floor((h - qr.size * scale) / 2)];
  const y = Buffer.alloc(w * h, 235);
  for (let r = 0; r < qr.size; r++) {
    for (let c = 0; c < qr.size; c++) {
      if (!qr.data[r][c]) continue;
      for (let dy = 0; dy < scale; dy++)
        y.fill(16, (oy + r * scale + dy) * w + ox + c * scale, (oy + r * scale + dy) * w + ox + (c + 1) * scale);
    }
  }
  const chroma = Buffer.alloc((w / 2) * (h / 2) * 2, 128);
  const file = path.join(os.tmpdir(), `quickscan-pairing-${Date.now()}.y4m`);
  await fs.writeFile(
    file,
    Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\nFRAME\n`), y, chroma]),
  );
  return file;
}

test('the scanner reads a real QR code from the camera with the jsQR fallback', async ({ browser, browserName }) => {
  test.skip(browserName !== 'chromium', 'fake camera video is Chromium-only');
  const email = `camera-${Date.now()}@example.com`;
  const first = await device(browser, email);
  await first.page.getByRole('button', { name: 'Turn on sync', exact: true }).click();
  const recoveryKey = (await first.page.getByTestId('recovery-key').textContent())!;
  await first.page.getByLabel("I've saved my recovery key").check();
  await first.page.getByRole('dialog').getByRole('button', { name: 'Turn on sync', exact: true }).click();
  await expect(first.page.getByText('Sync is on for this device')).toBeVisible();

  const laptop = await device(browser, email);
  const { code, fingerprint } = await showPairingCode(laptop.page);

  // A phone whose camera sees the laptop's QR code, without BarcodeDetector (as on iOS Safari).
  const cameraBrowser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${await qrVideo(code)}`,
    ],
  });
  const phone = await device(cameraBrowser, email);
  await phone.context.addInitScript(() => {
    delete (window as { BarcodeDetector?: unknown }).BarcodeDetector;
  });
  await phone.page.reload();
  await phone.page.getByLabel('Recovery key').fill(recoveryKey);
  await phone.page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await expect(phone.page.getByText('Sync is on for this device')).toBeVisible();

  await phone.page.getByRole('button', { name: 'Add a device', exact: true }).click();
  await expect(phone.page.getByRole('dialog').getByTestId('pairing-fingerprint')).toHaveText(fingerprint, {
    timeout: 15_000,
  });
  await expect(laptop.page.getByRole('heading', { name: 'Sync is on for this device' })).toBeVisible({
    timeout: 10_000,
  });

  await cameraBrowser.close();
  await first.context.close();
  await laptop.context.close();
});
