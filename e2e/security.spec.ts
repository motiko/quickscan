import { test, expect, type Page } from '@playwright/test';
import { resetDatabase, hideDevOverlay } from './helpers';

const PAGES = ['/', '/scan', '/settings', '/doc/does-not-exist'];

function directives(csp: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const part of csp.split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) map.set(name, values);
  }
  return map;
}

/**
 * Workers take the CSP of their own script response, and their violations reach neither
 * the document's `securitypolicyviolation` listeners nor the page console. So check in each
 * worker that what it needs is allowed: compiling WebAssembly, and (unlike the page) no eval.
 */
function watchWorkers(page: Page): () => Promise<string[]> {
  const checks: Promise<string>[] = [];
  page.on('worker', (worker) => {
    const name = new URL(worker.url()).pathname;
    checks.push(
      worker
        .evaluate(async () => {
          let wasm = 'wasm ok';
          try {
            await WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
          } catch (e) {
            wasm = `wasm blocked: ${(e as Error).message}`;
          }
          let evalResult = 'eval blocked';
          try {
            new Function('return 1')();
            evalResult = 'eval allowed';
          } catch {
            // expected
          }
          return `${wasm}, ${evalResult}`;
        })
        .then((result) => `${name}: ${result}`)
        // Tesseract terminates its worker when OCR goes idle
        .catch(() => `${name}: gone`)
    );
  });
  return async () => (await Promise.all(checks)).filter((r) => !r.endsWith(': gone'));
}

/** At least one worker matching `expected` ran, and every worker could compile WASM but not eval. */
async function expectWorkersLockedDown(page: Page, workers: () => Promise<string[]>, expected: RegExp) {
  const csp = (await page.request.get('/')).headers()['content-security-policy'];
  const dev = csp.split(';').some((d) => d.trim().startsWith('connect-src') && / ws:/.test(d));
  const results = await workers();
  expect(results.some((r) => expected.test(r)), results.join('\n')).toBe(true);
  for (const result of results) {
    expect(result).toMatch(dev ? /: wasm ok, eval (allowed|blocked)$/ : /: wasm ok, eval blocked$/);
  }
}

/** `securitypolicyviolation` events in the page, plus console reports of violations. */
async function watchViolations(page: Page): Promise<() => Promise<string[]>> {
  const consoleReports: string[] = [];
  page.on('console', (msg) => {
    if (/Content[- ]Security[- ]Policy|securitypolicyviolation/i.test(msg.text())) consoleReports.push(msg.text());
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __cspViolations: string[] };
    w.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__cspViolations.push(`${e.effectiveDirective} blocked ${e.blockedURI || 'inline'} (${e.sourceFile}:${e.lineNumber})`);
    });
  });
  return async () => {
    const events = await page
      .evaluate(() => (window as unknown as { __cspViolations?: string[] }).__cspViolations ?? [])
      .catch(() => []);
    return [...events, ...consoleReports];
  };
}

test.describe('Security headers', () => {
  test('documents carry a nonce CSP and the security headers', async ({ request }) => {
    const nonces = new Set<string>();
    for (const path of PAGES) {
      const response = await request.get(path);
      const headers = response.headers();
      const csp = headers['content-security-policy'];
      expect(csp, path).toBeTruthy();
      const d = directives(csp);

      // `next dev` adds 'unsafe-eval' (React error overlays) and ws: (HMR)
      const dev = d.get('connect-src')!.includes('ws:');
      const scriptSrc = d.get('script-src')!.filter((v) => !(dev && v === "'unsafe-eval'"));
      const nonce = scriptSrc.find((v) => v.startsWith("'nonce-"));
      expect(nonce).toBeTruthy();
      // No 'unsafe-inline', no eval, no hosts; only the workers compile WebAssembly
      expect(scriptSrc).toEqual(["'self'", nonce, "'strict-dynamic'"]);
      nonces.add(nonce!);
      // Next puts the nonce on its own scripts
      expect(await response.text()).toContain(`nonce="${nonce!.slice(7, -1)}"`);

      expect(d.get('default-src')).toEqual(["'self'"]);
      expect(d.get('object-src')).toEqual(["'none'"]);
      expect(d.get('base-uri')).toEqual(["'self'"]);
      expect(d.get('form-action')).toEqual(["'self'"]);
      expect(d.get('frame-ancestors')).toEqual(["'none'"]);
      expect(d.get('img-src')).toEqual(["'self'", 'blob:', 'data:']);

      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['permissions-policy']).toContain('camera=(self)');
      expect(headers['permissions-policy']).toContain('microphone=()');
      expect(headers['strict-transport-security']).toMatch(/max-age=\d+/);
      expect(headers['cross-origin-opener-policy']).toBe('same-origin');
      expect(headers['x-powered-by']).toBeUndefined();
    }
    // Fresh nonce per response
    expect(nonces.size).toBe(PAGES.length);
  });

  test('worker scripts get a CSP without a nonce', async ({ request }) => {
    const response = await request.get('/tesseract/worker.min.js');
    expect(response.ok()).toBeTruthy();
    const csp = response.headers()['content-security-policy'];
    const scriptSrc = directives(csp).get('script-src')!;
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc.some((v) => v.startsWith("'nonce-"))).toBe(false);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  test('manifest still loads', async ({ request }) => {
    const response = await request.get('/manifest.webmanifest');
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).name).toBe('QuickScan');
  });
});

test.describe('No CSP violations', () => {
  test('main pages', async ({ page }) => {
    const violations = await watchViolations(page);
    await hideDevOverlay(page);
    for (const path of ['/', '/settings', '/doc/does-not-exist']) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
    }
    expect(await violations()).toEqual([]);
  });

  test('scanner: camera, edge detection worker and capture', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', 'Camera emulation not supported in WebKit');
    const violations = await watchViolations(page);
    const workers = watchWorkers(page);
    await hideDevOverlay(page);
    await page.goto('/scan');
    const applyCrop = page.getByRole('button', { name: /Apply Crop/ });
    const shutter = page.getByLabel('Take photo');
    // Let the worker analyse a few frames before capturing
    await page.waitForTimeout(1500);
    if (!(await applyCrop.isVisible())) {
      await expect(shutter).toBeVisible({ timeout: 5000 });
      await shutter.click();
    }
    await expect(applyCrop).toBeVisible();
    await applyCrop.click();
    await expect(page.getByRole('button', { name: /Done/ })).toBeVisible();
    expect(await violations()).toEqual([]);
    await expectWorkersLockedDown(page, workers, /turbopack-worker/);
  });

  test('upload, OCR and PDF export', async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    // Tesseract downloads its language data on first use
    test.setTimeout(120_000);
    const violations = await watchViolations(page);
    const workers = watchWorkers(page);
    await hideDevOverlay(page);
    await resetDatabase(page);
    await page.goto('/');

    const png = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 600;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.fillStyle = '#000000';
      ctx.font = 'bold 64px Arial';
      ctx.fillText('ZEPPELIN INVOICE', 80, 200);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/png'));
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin);
    });
    await page
      .getByTestId('upload-input')
      .setInputFiles({ name: 'csp-check.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });

    await expect(page.getByRole('heading', { name: 'csp-check' })).toBeVisible();
    // OCR has run (Tesseract worker + WASM core from our origin) once the text is searchable
    await expect(page.getByText(/Recognizing text/)).toHaveCount(0, { timeout: 100_000 });
    await page.getByLabel('Search documents').fill('zeppelin');
    await expect(page.getByRole('heading', { name: 'csp-check' })).toBeVisible();

    await page.getByRole('heading', { name: 'csp-check' }).click();
    await expect(page).toHaveURL(/\/doc\//);
    const download = page.waitForEvent('download');
    await page.getByText('Download PDF').click();
    expect((await download).suggestedFilename()).toMatch(/\.pdf$/);

    expect(await violations()).toEqual([]);
    await expectWorkersLockedDown(page, workers, /^\/tesseract\/worker\.min\.js/);
  });
});
