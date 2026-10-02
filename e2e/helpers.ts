import { expect, type Page } from '@playwright/test';

export async function resetDatabase(page: Page) {
  await page.goto('/');
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase('QuickScanDB');
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
      })
  );
}

interface SeedOptions {
  name?: string;
  text?: string;
  ocrInfo?: { languages: string[]; detectedLanguage?: string; confidence?: number };
}

/**
 * Let the app create its schema, then insert a one-page document whose page is already
 * recognized.
 */
export async function seedDocument(
  page: Page,
  { name = 'Scan 2026-10-01 12:00', text = '', ocrInfo }: SeedOptions = {}
) {
  await page.goto('/');
  // The gallery has queried the DB once this shows, so the schema exists
  await expect(page.getByText('No documents yet')).toBeVisible();
  await page.evaluate(
    async ({ text, name, ocrInfo }) => {
      const blob: Blob = await new Promise((r) => {
        const c = document.createElement('canvas');
        c.width = 600;
        c.height = 800;
        const ctx = c.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.fillStyle = '#000000';
        ctx.font = '28px Arial';
        ctx.fillText('Test page', 40, 60);
        c.toBlob((b) => r(b!), 'image/jpeg');
      });
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['documents', 'pages'], 'readwrite');
          const now = new Date();
          tx.objectStore('documents').put({
            id: 'd1', name, createdAt: now, updatedAt: now, pageCount: 1, nameSource: 'default', thumbnailBlob: blob,
          });
          tx.objectStore('pages').put({
            id: 'p1', documentId: 'd1', pageNumber: 1, originalBlob: blob, processedBlob: blob,
            filter: 'original', createdAt: now, ocrStatus: 'done', ocrText: text, ocrWords: [],
            ...(ocrInfo && { ocrInfo: { engine: 'tesseract', recognizedAt: now, ...ocrInfo } }),
          });
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { text, name, ocrInfo }
  );
}

/** Read a record straight from IndexedDB. */
export function readRecord<T>(page: Page, store: string, key: string): Promise<T> {
  return page.evaluate(
    ({ store, key }) =>
      new Promise<T>((resolve, reject) => {
        const req = indexedDB.open('QuickScanDB');
        req.onsuccess = () => {
          const get = req.result.transaction(store).objectStore(store).get(key);
          get.onsuccess = () => {
            req.result.close();
            resolve(get.result);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    { store, key }
  );
}

/** The Next.js dev indicator floats over the bottom-left corner and swallows clicks there. */
export async function hideDevOverlay(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = 'nextjs-portal { display: none !important; }';
    document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
  });
}
