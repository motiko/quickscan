import { test, expect, type Locator, type Page } from '@playwright/test';
import { hideDevOverlay, readRecord, resetDatabase, seedDocument } from './helpers';
import type { Annotation, Page as ScanPage } from '../src/types';

async function drag(page: Page, target: Locator, from: [number, number], to: [number, number]) {
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], { steps: 8 });
  await page.mouse.up();
}

async function tap(page: Page, target: Locator, at: [number, number]) {
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + box.width * at[0], box.y + box.height * at[1]);
}

function thumbnailSize(page: Page) {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          const get = req.result.transaction('documents').objectStore('documents').get('d1');
          get.onsuccess = () => resolve(get.result.thumbnailBlob.size);
        };
      })
  );
}

async function annotationsOf(page: Page) {
  return (await readRecord<ScanPage>(page, 'pages', 'p1')).annotations ?? [];
}

test.describe('Annotation', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    await hideDevOverlay(page);
    await resetDatabase(page);
    await seedDocument(page);
    await page.goto('/doc/d1');
    await page.getByAltText('Page 1').click();
  });

  test('draws with every tool, saves, and keeps annotations aligned on rotate', async ({ page }) => {
    const thumbBefore = await thumbnailSize(page);
    await page.getByRole('button', { name: 'Annotate' }).click();
    const canvas = page.getByLabel('Annotation canvas');
    await expect(canvas).toBeVisible();
    const tools = page.getByRole('toolbar', { name: 'Annotation tools' });

    // Pen is the default tool
    await drag(page, canvas, [0.2, 0.2], [0.6, 0.25]);
    await tools.getByRole('button', { name: 'Highlight' }).click();
    await drag(page, canvas, [0.1, 0.08], [0.5, 0.08]);
    await tools.getByRole('button', { name: 'Rectangle' }).click();
    await drag(page, canvas, [0.5, 0.5], [0.2, 0.4]); // drawn up-left on purpose
    await tools.getByRole('button', { name: 'Arrow' }).click();
    await drag(page, canvas, [0.6, 0.6], [0.8, 0.7]);

    // Undo the arrow, then bring it back
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('button', { name: 'Redo' })).toBeEnabled();
    await page.getByRole('button', { name: 'Redo' }).click();

    await tools.getByRole('button', { name: 'Text' }).click();
    await tap(page, canvas, [0.1, 0.8]);
    await page.getByLabel('Annotation text').fill('Approved');
    await tools.getByRole('button', { name: 'Select' }).click();

    await tools.getByRole('button', { name: 'Signature' }).click();
    const pad = page.getByLabel('Signature drawing area');
    await drag(page, pad, [0.2, 0.6], [0.5, 0.3]);
    await drag(page, pad, [0.5, 0.3], [0.8, 0.6]);
    await page.getByRole('button', { name: 'Save & place' }).click();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(canvas).toBeHidden();

    const saved = await annotationsOf(page);
    expect(saved.map((a) => a.type)).toEqual(['stroke', 'stroke', 'rect', 'arrow', 'text', 'signature']);
    expect(saved.find((a) => a.type === 'text')).toMatchObject({ text: 'Approved' });
    const rect = saved.find((a) => a.type === 'rect') as Extract<Annotation, { type: 'rect' }>;
    expect(rect.w).toBeGreaterThan(0);
    expect(rect.h).toBeGreaterThan(0);
    expect(rect.x).toBeCloseTo(0.2, 1);
    expect(rect.y).toBeCloseTo(0.4, 1);
    await expect.poll(() => thumbnailSize(page)).not.toBe(thumbBefore);

    // Rotating the page re-maps the annotations: normalized (x, y) -> (1 - y, x)
    await page.getByRole('button', { name: 'Rotate' }).click();
    await expect
      .poll(async () => (await annotationsOf(page)).find((a) => a.type === 'rect'))
      .toMatchObject({ x: expect.closeTo(1 - (rect.y + rect.h), 5), y: expect.closeTo(rect.x, 5), w: expect.closeTo(rect.h, 5) });
  });

  test('selects, recolors and deletes an annotation', async ({ page }) => {
    await page.getByRole('button', { name: 'Annotate' }).click();
    const canvas = page.getByLabel('Annotation canvas');
    const tools = page.getByRole('toolbar', { name: 'Annotation tools' });

    await tools.getByRole('button', { name: 'Rectangle' }).click();
    await drag(page, canvas, [0.2, 0.2], [0.6, 0.5]);
    await tools.getByRole('button', { name: 'Arrow' }).click();
    await drag(page, canvas, [0.2, 0.8], [0.7, 0.8]);
    await tools.getByRole('button', { name: 'Select' }).click();

    // Inside an empty rectangle doesn't select it; its edge does
    await tap(page, canvas, [0.4, 0.35]);
    await expect(page.getByRole('button', { name: 'Delete selected' })).toBeHidden();
    await tap(page, canvas, [0.2, 0.35]);
    await expect(page.getByRole('button', { name: 'Delete selected' })).toBeVisible();

    await page.getByRole('button', { name: 'Color red' }).click();
    // Drag it somewhere else
    await drag(page, canvas, [0.2, 0.35], [0.3, 0.45]);
    await page.getByRole('button', { name: 'Done' }).click();

    let saved = await annotationsOf(page);
    expect(saved[0]).toMatchObject({ type: 'rect', color: '#dc2626', x: expect.closeTo(0.3, 1), y: expect.closeTo(0.3, 1) });

    // Reopen: the arrow can be deleted
    await page.getByRole('button', { name: 'Annotate' }).click();
    await tools.getByRole('button', { name: 'Select' }).click();
    await tap(page, canvas, [0.45, 0.8]);
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await page.getByRole('button', { name: 'Done' }).click();

    saved = await annotationsOf(page);
    expect(saved.map((a) => a.type)).toEqual(['rect']);
  });
});
