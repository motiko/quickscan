import { test, expect, type Page } from '@playwright/test';
import { readRecord, resetDatabase, seedDocument } from './helpers';

/** Adds a second document next to the seeded 'd1', reusing its thumbnail and page image. */
async function addSecondDocument(page: Page, name: string) {
  await page.evaluate(
    (name) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['documents', 'pages'], 'readwrite');
          const docs = tx.objectStore('documents');
          const pages = tx.objectStore('pages');
          docs.get('d1').onsuccess = (e) => {
            const doc = (e.target as IDBRequest).result;
            docs.put({ ...doc, id: 'd2', name, updatedAt: new Date(doc.updatedAt.getTime() - 1000) });
          };
          pages.get('p1').onsuccess = (e) => {
            const p = (e.target as IDBRequest).result;
            pages.put({ ...p, id: 'p2', documentId: 'd2' });
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    name
  );
}

/** The tag chips of the document page, without the "Add tag" button. */
function tagChips(page: Page) {
  return page
    .getByRole('list', { name: 'Tags' })
    .getByRole('listitem')
    .filter({ has: page.getByRole('button', { name: /^Remove tag/ }) });
}

async function addTag(page: Page, tag: string) {
  const input = page.getByRole('textbox', { name: 'New tag' });
  if (!(await input.isVisible())) await page.getByRole('button', { name: 'Add tag', exact: true }).click();
  await input.fill(tag);
  await input.press('Enter');
}

test.describe('Folders & tags', () => {
  test.beforeEach(async ({ page, browserName }) => {
    test.skip(browserName === 'webkit', "Playwright's WebKit can't store Blobs in IndexedDB");
    page.on('dialog', () => {
      throw new Error('Native browser dialogs must not be used');
    });
    await resetDatabase(page);
    await seedDocument(page, { name: 'Electricity bill' });
    await addSecondDocument(page, 'Gym contract');
  });

  test('file a document in a new folder and tag it', async ({ page }) => {
    await page.goto('/doc/d1');
    const organizer = page.getByRole('region', { name: 'Folder and tags' });

    await organizer.getByRole('button', { name: /^Folder: Unfiled/ }).click();
    const picker = page.getByRole('dialog', { name: 'Move to folder' });
    await picker.getByRole('button', { name: 'New folder…' }).click();
    const prompt = page.getByRole('dialog', { name: 'New folder' });
    await prompt.getByRole('textbox', { name: 'Folder name' }).fill('Bills');
    await prompt.getByRole('button', { name: 'Create' }).click();
    await expect(organizer.getByRole('button', { name: /^Folder: Bills/ })).toBeVisible();
    await expect(picker).not.toBeVisible();

    await addTag(page, 'Utilities');
    await addTag(page, '#2026');
    await expect(tagChips(page)).toHaveText(['2026', 'Utilities']);

    await organizer.getByRole('button', { name: 'Remove tag 2026' }).click();
    await expect(tagChips(page)).toHaveText(['Utilities']);

    const doc = await readRecord<{ folderId: string; tags: string[] }>(page, 'documents', 'd1');
    expect(doc.tags).toEqual(['Utilities']);
    expect(typeof doc.folderId).toBe('string');

    // The other document gets the existing tag from the suggestions
    await page.goto('/doc/d2');
    await page.getByRole('button', { name: 'Add tag', exact: true }).click();
    await page.getByRole('textbox', { name: 'New tag' }).fill('util');
    await page.getByRole('button', { name: 'Add tag Utilities' }).click();
    await expect(tagChips(page)).toHaveText(['Utilities']);

    // Moving it out of a folder again
    await page.goto('/doc/d1');
    await organizer.getByRole('button', { name: /^Folder: Bills/ }).click();
    await page.getByRole('dialog', { name: 'Move to folder' }).getByRole('button', { name: 'Unfiled' }).click();
    await expect(organizer.getByRole('button', { name: /^Folder: Unfiled/ })).toBeVisible();
  });

  test('filter the gallery by folder and tag, and search tags', async ({ page }) => {
    await page.goto('/doc/d1');
    await page.getByRole('button', { name: /^Folder: Unfiled/ }).click();
    await page.getByRole('button', { name: 'New folder…' }).click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Bills');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /^Folder: Bills/ })).toBeVisible();
    await addTag(page, 'Utilities');
    await page.goto('/doc/d2');
    await addTag(page, 'Sport');

    await page.goto('/');
    const cards = page.getByRole('heading', { level: 3 });
    await expect(cards).toHaveCount(2);

    const folders = page.getByRole('group', { name: 'Filter by folder' });
    await folders.getByRole('button', { name: /^Bills/ }).click();
    await expect(cards).toHaveText(['Electricity bill']);
    await folders.getByRole('button', { name: /^Unfiled/ }).click();
    await expect(cards).toHaveText(['Gym contract']);
    await folders.getByRole('button', { name: /^All/ }).click();
    await expect(cards).toHaveCount(2);

    const tags = page.getByRole('group', { name: 'Filter by tag' });
    await tags.getByRole('button', { name: 'Tag Sport' }).click();
    await expect(cards).toHaveText(['Gym contract']);
    // The filter is kept when coming back from a document
    await page.getByRole('link', { name: /Gym contract/ }).click();
    await page.getByRole('button', { name: 'Back to gallery' }).click();
    await expect(cards).toHaveText(['Gym contract']);
    await expect(tags.getByRole('button', { name: 'Tag Sport' })).toHaveAttribute('aria-pressed', 'true');
    // Both tags at once match nothing
    await tags.getByRole('button', { name: 'Tag Utilities' }).click();
    await expect(page.getByText('No documents match these filters.')).toBeVisible();
    await page.getByRole('button', { name: 'Show all documents' }).click();
    await expect(cards).toHaveCount(2);

    await page.getByRole('searchbox', { name: 'Search documents' }).fill('utilit');
    await expect(cards).toHaveText(['Electricity bill']);
  });

  test('rename and delete folders and tags from the gallery', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Folder name' }).fill('Bils');
    await page.getByRole('button', { name: 'Create' }).click();
    // The new folder is selected and empty
    await expect(page.getByText('“Bils” is empty.', { exact: false })).toBeVisible();

    await page.goto('/doc/d1');
    await page.getByRole('button', { name: /^Folder: Unfiled/ }).click();
    await page.getByRole('dialog', { name: 'Move to folder' }).getByRole('button', { name: 'Bils' }).click();
    await addTag(page, 'Utilites');
    await page.goto('/doc/d2');
    await addTag(page, 'Utilites');
    await page.goto('/');

    await page.getByRole('button', { name: 'Manage folders and tags' }).click();
    const sheet = page.getByRole('dialog', { name: 'Folders & tags' });

    await sheet.getByRole('button', { name: 'Rename folder Bils' }).click();
    const renameFolder = page.getByRole('dialog', { name: 'Rename folder' });
    await renameFolder.getByRole('textbox', { name: 'Folder name' }).fill('Bills');
    await renameFolder.getByRole('button', { name: 'Rename' }).click();
    await expect(sheet.getByText('Bills', { exact: true })).toBeVisible();

    await sheet.getByRole('button', { name: 'Rename tag Utilites' }).click();
    const renameTag = page.getByRole('dialog', { name: 'Rename tag' });
    await renameTag.getByRole('textbox', { name: 'Tag name' }).fill('Utilities');
    await renameTag.getByRole('button', { name: 'Rename' }).click();
    await expect(sheet.getByText('Utilities', { exact: true })).toBeVisible();
    expect((await readRecord<{ tags: string[] }>(page, 'documents', 'd2')).tags).toEqual(['Utilities']);

    // Deleting the folder keeps its document, now unfiled
    await sheet.getByRole('button', { name: 'Delete folder Bills' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete “Bills”?' });
    await expect(confirm).toContainText('moves to Unfiled');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(sheet.getByText('No folders yet.', { exact: false })).toBeVisible();
    expect((await readRecord<{ folderId?: string }>(page, 'documents', 'd1')).folderId).toBeUndefined();

    await sheet.getByRole('button', { name: 'Delete tag Utilities' }).click();
    await page.getByRole('alertdialog', { name: 'Delete tag “Utilities”?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(sheet.getByText('No tags yet.', { exact: false })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet).not.toBeVisible();
    await expect(page.getByRole('heading', { level: 3 })).toHaveCount(2);
  });
});
