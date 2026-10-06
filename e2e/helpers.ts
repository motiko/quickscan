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
          const tx = db.transaction(['documents', 'pages', 'images'], 'readwrite');
          const now = new Date();
          // Images are rows of their own that records point to (src/lib/images.ts)
          tx.objectStore('images').put({ id: 'img1', blob, createdAt: now });
          tx.objectStore('images').put({ id: 'thumb1', blob, createdAt: now });
          tx.objectStore('documents').put({
            id: 'd1', name, createdAt: now, updatedAt: now, pageCount: 1, nameSource: 'default', thumbnailId: 'thumb1',
          });
          tx.objectStore('pages').put({
            id: 'p1', documentId: 'd1', pageNumber: 1, originalImageId: 'img1', processedImageId: 'img1',
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

interface SeedPagesOptions {
  name?: string;
  pages?: number;
  /** Recognized text of every page ('' = recognized, nothing found). */
  text?: string;
  ocrStatus?: 'pending' | 'processing' | 'done' | 'error';
  tags?: string[];
  /** Configure an LLM so AI features (Summarize) show. Nothing is sent unless a test taps them. */
  llm?: boolean;
}

/** Like seedDocument, with several pages, tags, an OCR state and optionally an LLM configured. */
export async function seedPages(
  page: Page,
  { name = 'Scan 2026-10-01 12:00', pages = 1, text = '', ocrStatus = 'done', tags, llm = false }: SeedPagesOptions = {}
) {
  await page.goto('/');
  await expect(page.getByText('No documents yet')).toBeVisible();
  await page.evaluate(
    async ({ name, pages, text, ocrStatus, tags, llm }) => {
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
          const tx = db.transaction(['documents', 'pages', 'images', 'settings'], 'readwrite');
          const now = new Date();
          // Images are rows of their own that records point to (src/lib/images.ts)
          tx.objectStore('images').put({ id: 'img1', blob, createdAt: now });
          tx.objectStore('images').put({ id: 'thumb1', blob, createdAt: now });
          tx.objectStore('documents').put({
            id: 'd1', name, createdAt: now, updatedAt: now, pageCount: pages, nameSource: 'user', thumbnailId: 'thumb1',
            ...(tags && { tags }),
          });
          for (let i = 1; i <= pages; i++) {
            tx.objectStore('pages').put({
              id: `p${i}`, documentId: 'd1', pageNumber: i, originalImageId: 'img1', processedImageId: 'img1',
              filter: 'original', createdAt: now, updatedAt: now, ocrStatus, ocrText: text, ocrWords: [],
            });
          }
          if (llm) {
            tx.objectStore('settings').put({ key: 'llmEnabled', value: true });
            tx.objectStore('settings').put({ key: 'openaiApiKey', value: 'sk-e2e' });
            tx.objectStore('settings').put({ key: 'openaiModel', value: 'gpt-e2e' });
          }
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { name, pages, text, ocrStatus, tags, llm }
  );
}
