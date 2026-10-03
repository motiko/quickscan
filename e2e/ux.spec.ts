/**
 * Rendered checks behind docs/ux-rules.md. Each test is named after the rule it enforces.
 * Animations are disabled and data is seeded, so the checks are deterministic.
 */
import { test, expect, type Page, type Locator } from '@playwright/test';
import { hideDevOverlay, resetDatabase, seedPages } from './helpers';

const SCHEMES = ['light', 'dark'] as const;

async function openDocument(page: Page) {
  await page.goto('/doc/d1');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important}' });
}

/** Hold OCR in 'processing': the Tesseract worker never loads. */
async function stallOcr(page: Page) {
  await page.route('**/tesseract/**', () => new Promise(() => {}));
}

/** Visible, enabled controls inside `scope` (or the page) that a finger has to hit. */
async function touchTargets(scope: Locator) {
  return scope.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>('button, a[href], input:not([type=hidden]), select, textarea, [role=button]')]
      .filter((c) => {
        const r = c.getBoundingClientRect();
        const style = getComputedStyle(c);
        return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && !(c as HTMLButtonElement).disabled;
      })
      .map((c) => {
        const r = c.getBoundingClientRect();
        const name = c.getAttribute('aria-label') || c.textContent?.trim() || c.getAttribute('title') || c.tagName;
        return { name, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
      })
  );
}

function tooSmall(targets: { name: string; width: number; height: number }[]) {
  return targets.filter((t) => t.width < 44 || t.height < 44);
}

/**
 * WCAG contrast of every visible text run against the backgrounds painted under it, with
 * ancestor opacity applied (so faded "disabled" text counts). Colors are resolved through a
 * canvas, which handles any CSS color syntax (Tailwind 4 uses oklch).
 */
async function lowContrastText(page: Page) {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    type RGBA = [number, number, number, number];
    const parse = (css: string): RGBA => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000';
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    const over = (top: RGBA, under: RGBA): RGBA => {
      const a = top[3] + under[3] * (1 - top[3]);
      if (a === 0) return [0, 0, 0, 0];
      const mix = (i: number) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
      return [mix(0), mix(1), mix(2), a];
    };
    const lum = ([r, g, b]: RGBA) => {
      const ch = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
    };
    const pageBg = parse(getComputedStyle(document.body).backgroundColor);

    const failures: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<Element>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      if (rect.width === 0 || rect.height === 0 || style.visibility === 'hidden' || el.closest('[aria-hidden=true], .sr-only, nextjs-portal')) continue;

      // Backgrounds from the root down to the element, and the opacity of every ancestor
      const chain: Element[] = [];
      for (let a: Element | null = el; a; a = a.parentElement) chain.unshift(a);
      let bg = pageBg;
      let opacity = 1;
      for (const a of chain) {
        const s = getComputedStyle(a);
        opacity *= Number(s.opacity);
        bg = over(parse(s.backgroundColor), bg);
      }
      const fgRaw = parse(style.color);
      const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity], bg);
      const [l1, l2] = [lum(fg), lum(bg)].sort((x, y) => y - x);
      const ratio = (l1 + 0.05) / (l2 + 0.05);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) failures.push(`"${n.textContent.trim().slice(0, 40)}" ${ratio.toFixed(2)}:1`);
    }
    return failures;
  });
}

test.describe('Document page', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await hideDevOverlay(page);
    await resetDatabase(page);
  });

  for (const scheme of SCHEMES) {
    test(`UX-001: touch targets are at least 44×44 px (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await seedPages(page, { pages: 2, text: 'Invoice total 42.00', tags: ['insurance'], llm: true });
      await openDocument(page);
      expect(tooSmall(await touchTargets(page.locator('body'))), 'document page').toEqual([]);

      await page.getByRole('button', { name: 'Open page 1' }).click();
      const viewer = page.getByRole('dialog', { name: /Page 1 of 2/ });
      await expect(viewer).toBeVisible();
      expect(tooSmall(await touchTargets(viewer)), 'page viewer').toEqual([]);

      await viewer.getByRole('button', { name: 'Show page text' }).click();
      const sheet = page.getByRole('dialog', { name: 'Recognized text' });
      await expect(sheet).toBeVisible();
      expect(tooSmall(await touchTargets(sheet)), 'text sheet').toEqual([]);
    });

    test(`UX-005: text meets WCAG AA contrast, disabled controls included (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await stallOcr(page);
      // OCR still running: Summarize is shown disabled with its reason
      await seedPages(page, { pages: 2, ocrStatus: 'pending', tags: ['insurance'], llm: true });
      await openDocument(page);
      await expect(page.getByText('Available once text recognition finishes')).toBeVisible();
      expect(await lowContrastText(page)).toEqual([]);
    });
  }

  test('UX-006: the bottom toolbar never covers page content', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await seedPages(page, { pages: 6, text: 'Invoice' });
    await openDocument(page);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const toolbar = await page.getByRole('group', { name: 'Document actions' }).locator('..').boundingBox();
    const lastPage = await page.getByRole('button', { name: 'Open page 6' }).boundingBox();
    expect(toolbar && lastPage).toBeTruthy();
    expect(lastPage!.y + lastPage!.height).toBeLessThanOrEqual(toolbar!.y);
  });

  test('UX-007: anything that looks clickable is a focusable control', async ({ page }) => {
    await seedPages(page, { pages: 2, text: 'Invoice' });
    await openDocument(page);
    const fakeControls = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('body *')]
        .filter((el) => getComputedStyle(el).cursor === 'pointer')
        .filter((el) => !el.closest('button, a[href], input, select, textarea, label, summary, [role=button], [tabindex]'))
        .map((el) => `${el.tagName.toLowerCase()}.${el.className.toString().split(' ').slice(0, 3).join('.')}`)
    );
    expect(fakeControls).toEqual([]);
  });

  test('UX-008: the page viewer takes focus when it opens and gives it back when it closes', async ({ page }) => {
    await seedPages(page, { pages: 2, text: 'Invoice' });
    await openDocument(page);
    const thumbnail = page.getByRole('button', { name: 'Open page 2' });
    await thumbnail.focus();
    await page.keyboard.press('Enter');
    const viewer = page.getByRole('dialog', { name: /Page 2 of 2/ });
    await expect(viewer).toBeVisible();
    expect(await viewer.evaluate((v) => v.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(viewer).not.toBeVisible();
    await expect(thumbnail).toBeFocused();
  });

  test('UX-009: header and toolbar actions show a text label', async ({ page }) => {
    await seedPages(page, { pages: 1, text: 'Invoice' });
    await openDocument(page);
    // Back is the one universally understood icon
    const iconOnly = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('header button, [role=group][aria-label$="actions"] button')]
        .filter((b) => b.getAttribute('aria-label') !== 'Back to gallery')
        .filter((b) => !b.innerText.trim())
        .map((b) => b.getAttribute('aria-label') ?? b.outerHTML.slice(0, 60))
    );
    expect(iconOnly).toEqual([]);
  });

  test('UX-010: the header grows with 200% text instead of clipping', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await seedPages(page, { pages: 1, text: 'Invoice' });
    await openDocument(page);
    await page.addStyleTag({ content: 'html{font-size:200%!important}' });
    const escaped = await page.locator('header').evaluate((header) => {
      const box = header.getBoundingClientRect();
      return [...header.querySelectorAll<HTMLElement>('h1, p, button')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5;
        })
        .map((el) => el.innerText.trim().slice(0, 30) || el.getAttribute('aria-label'));
    });
    expect(escaped).toEqual([]);
    // Nothing pushes the page sideways
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    // Toolbar labels scale with the text size too (rem, not px)
    const label = page.getByRole('group', { name: 'Document actions' }).getByText('Text', { exact: true });
    expect(await label.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(24);
  });

  test('UX-013: when recognition finds no text, the page says how to fix it instead of offering dead ends', async ({ page }) => {
    await seedPages(page, { pages: 1, text: '', llm: true });
    await openDocument(page);
    const notice = page.getByRole('status').filter({ hasText: 'No text recognized' });
    await expect(notice).toContainText('Rotate');
    // Nothing to summarize and nothing coming: no disabled Summarize button
    await expect(page.getByRole('button', { name: 'Summarize' })).toHaveCount(0);
    await notice.getByRole('button', { name: 'Open page' }).click();
    const viewer = page.getByRole('dialog', { name: 'Page 1 of 1' });
    await expect(viewer.getByText('No text found on this page.', { exact: false })).toBeVisible();
    await expect(viewer.getByRole('button', { name: 'Rotate' })).toBeEnabled();
  });

  test('UX-012: a disabled control says why', async ({ page }) => {
    await stallOcr(page);
    await seedPages(page, { pages: 1, ocrStatus: 'pending', llm: true });
    await openDocument(page);
    await expect(page.getByRole('button', { name: 'Summarize' })).toBeDisabled();
    const undescribed = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('button:disabled')]
        .filter((b) => {
          const ids = b.getAttribute('aria-describedby')?.split(/\s+/) ?? [];
          return !ids.some((id) => document.getElementById(id)?.textContent?.trim());
        })
        .map((b) => b.getAttribute('aria-label') || b.innerText.trim())
    );
    expect(undescribed).toEqual([]);
  });
});
