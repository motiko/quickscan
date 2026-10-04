import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  });

  it('returns the pages in order as JPEG blobs', async () => {
    scanDocument = async () => ({ status: 'success', scannedImages: [btoa('page 1'), btoa('page 2')] });

    const scan = await scanWithSystemScanner();

    expect(scan.status).toBe('scanned');
    const pages = scan.status === 'scanned' ? scan.pages : [];
    expect(pages.map((p) => p.type)).toEqual(['image/jpeg', 'image/jpeg']);
    expect(await Promise.all(pages.map((p) => p.text()))).toEqual(['page 1', 'page 2']);
    expect(calls.map((c) => c.method)).not.toContain('then');
  });

  it('keeps VisionKit’s own flow and leaves no files behind', async () => {
    scanDocument = async () => ({ status: 'cancel' });
    await scanWithSystemScanner();
    expect(calls).toEqual([{ method: 'scanDocument', args: [{ letUserAdjustCrop: false, responseType: 'base64' }] }]);
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

  it('tells apart why the scanner didn’t start', () => {
    expect(unavailableReason(new Error('Document scanner is not supported on Android emulators. …'))).toBe('unsupported');
    expect(unavailableReason(new Error('VisionKit document scanning is not supported on this device.'))).toBe('unsupported');
    expect(unavailableReason(new Error('Unable to start document scanner: Waiting for the module to be downloaded'))).toBe('not-ready');
    expect(unavailableReason(new Error('Camera permission denied'))).toBe('permission');
    expect(unavailableReason(new Error('Another scan is in progress.'))).toBe('failed');
  });
});
