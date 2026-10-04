import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Like Capacitor's registerPlugin: a proxy that turns every property, `then` included, into a
// native call. The native side has no "then" method, so that call never answers.
const calls: { method: string; args: unknown[] }[] = [];
let scanDocument: (options: unknown) => Promise<unknown> = async () => ({ status: 'cancel' });
vi.mock('@capgo/capacitor-document-scanner', () => ({
  DocumentScanner: new Proxy(
    {},
    {
      get: (_, prop) => (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        if (prop === 'scanDocument') return scanDocument(args[0]);
        return new Promise(() => void args);
      },
    }
  ),
}));

const { scanWithSystemScanner, unavailableReason } = await import('@/lib/platform/native/scanner');

describe('system document scanner', () => {
  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal('Capacitor', { convertFileSrc: (path: string) => `https://localhost/_capacitor_file_${path}` });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => new Response(new Blob([url], { type: 'image/jpeg' })))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the pages in order, read through their file URLs', async () => {
    scanDocument = async () => ({ status: 'success', scannedImages: ['/cache/page-0.jpg', '/cache/page-1.jpg'] });

    const scan = await scanWithSystemScanner();

    expect(scan.status).toBe('scanned');
    const pages = scan.status === 'scanned' ? scan.pages : [];
    expect(await Promise.all(pages.map((p) => p.text()))).toEqual([
      'https://localhost/_capacitor_file_/cache/page-0.jpg',
      'https://localhost/_capacitor_file_/cache/page-1.jpg',
    ]);
    expect(calls.map((c) => c.method)).not.toContain('then');
  });

  it('keeps VisionKit’s own flow (no private-API review screen)', async () => {
    scanDocument = async () => ({ status: 'cancel' });
    await scanWithSystemScanner();
    expect(calls).toEqual([{ method: 'scanDocument', args: [{ letUserAdjustCrop: false }] }]);
  });

  it('reports a cancelled or empty scan as cancelled', async () => {
    scanDocument = async () => ({ status: 'cancel' });
    await expect(scanWithSystemScanner()).resolves.toEqual({ status: 'cancelled' });
    scanDocument = async () => ({ status: 'success', scannedImages: [] });
    await expect(scanWithSystemScanner()).resolves.toEqual({ status: 'cancelled' });
  });

  it('reports a scanner that can’t start as unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    scanDocument = async () => {
      throw new Error('The ML Kit Document Scanner requires Google Play Services, which is not available or needs an update. ');
    };
    await expect(scanWithSystemScanner()).resolves.toEqual({ status: 'unavailable', reason: 'play-services' });
  });

  it('fails when a scanned page can’t be read', async () => {
    scanDocument = async () => ({ status: 'success', scannedImages: ['/gone.jpg'] });
    vi.stubGlobal('fetch', async () => new Response(null, { status: 404 }));
    await expect(scanWithSystemScanner()).rejects.toThrow('(404)');
  });

  it('tells apart why the scanner didn’t start', () => {
    expect(unavailableReason(new Error('Document scanner is not supported on Android emulators. …'))).toBe('unsupported');
    expect(unavailableReason(new Error('VisionKit document scanning is not supported on this device.'))).toBe('unsupported');
    expect(unavailableReason(new Error('Unable to start document scanner: Waiting for the module to be downloaded'))).toBe('not-ready');
    expect(unavailableReason(new Error('Camera permission denied'))).toBe('permission');
    expect(unavailableReason(new Error('Another scan is in progress.'))).toBe('failed');
  });
});
