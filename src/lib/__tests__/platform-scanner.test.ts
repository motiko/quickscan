import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SystemScan } from '@/lib/platform/native/scanner';

const scanWithSystemScanner = vi.fn<() => Promise<SystemScan>>();
vi.mock('@/lib/platform/native/scanner', () => ({ scanWithSystemScanner }));
vi.mock('@/lib/import', () => ({ importScan: vi.fn(async (_pages: Blob[], docId?: string) => docId ?? 'new-doc') }));
vi.mock('@/lib/dialogs', () => ({ alertDialog: vi.fn(async () => {}) }));

const { importScan } = await import('@/lib/import');
const { alertDialog } = await import('@/lib/dialogs');
const { startScan } = await import('@/lib/platform/scanner');

describe('startScan', () => {
  const navigate = vi.fn();

  beforeEach(() => {
    navigate.mockClear();
    scanWithSystemScanner.mockReset();
    vi.mocked(importScan).mockClear();
    vi.mocked(alertDialog).mockClear();
    vi.stubGlobal('Capacitor', { isNativePlatform: () => true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the camera page on the web', async () => {
    vi.stubGlobal('Capacitor', undefined);
    await startScan(navigate);
    await startScan(navigate, 'doc-1');
    expect(navigate.mock.calls).toEqual([['/scan'], ['/scan?docId=doc-1']]);
    expect(scanWithSystemScanner).not.toHaveBeenCalled();
  });

  it('imports a scan as one document and opens it', async () => {
    const pages = [new Blob(['1']), new Blob(['2'])];
    scanWithSystemScanner.mockResolvedValue({ status: 'scanned', pages });
    await startScan(navigate);
    expect(importScan).toHaveBeenCalledWith(pages, undefined);
    expect(navigate).toHaveBeenCalledWith('/doc/new-doc');
  });

  it('adds the pages to a document without leaving it', async () => {
    scanWithSystemScanner.mockResolvedValue({ status: 'scanned', pages: [new Blob(['1'])] });
    await startScan(navigate, 'doc-1');
    expect(importScan).toHaveBeenCalledWith([expect.any(Blob)], 'doc-1');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('does nothing when the scan is cancelled', async () => {
    scanWithSystemScanner.mockResolvedValue({ status: 'cancelled' });
    await startScan(navigate);
    expect(importScan).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(alertDialog).not.toHaveBeenCalled();
  });

  it('falls back to the built-in camera with a note', async () => {
    scanWithSystemScanner.mockResolvedValue({ status: 'unavailable', reason: 'play-services' });
    await startScan(navigate, 'doc-1');
    expect(alertDialog).toHaveBeenCalledWith({
      title: 'Using the built-in camera',
      message: 'The document scanner needs Google Play services.',
    });
    expect(navigate).toHaveBeenCalledWith('/scan?docId=doc-1');
    expect(importScan).not.toHaveBeenCalled();
  });

  it('ignores a second tap while the scanner is open', async () => {
    let finish: (scan: SystemScan) => void = () => {};
    scanWithSystemScanner.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const first = startScan(navigate);
    await startScan(navigate);
    finish({ status: 'cancelled' });
    await first;
    expect(scanWithSystemScanner).toHaveBeenCalledTimes(1);
  });
});
