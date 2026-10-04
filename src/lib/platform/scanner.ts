import { isNativeApp } from '@/lib/native-passkey';
import { importScan } from '@/lib/import';
import { alertDialog } from '@/lib/dialogs';
import { docHref } from '@/lib/routes';
import type { ScannerUnavailableReason, SystemScan } from '@/lib/platform/native/scanner';

/*
 * Where a scan button leads. On the web: /scan, the app's own camera. Inside the iOS/Android
 * app: the system document scanner (`native/scanner.ts`), with /scan kept as the built-in
 * camera for when the scanner can't run, or when the user picks it.
 */

/** Whether scan buttons open the system document scanner rather than /scan. */
export function usesSystemScanner(): boolean {
  return isNativeApp();
}

/** The built-in camera, adding pages to `documentId` when given. */
export function cameraHref(documentId?: string): string {
  return documentId ? `/scan?docId=${encodeURIComponent(documentId)}` : '/scan';
}

const UNAVAILABLE_MESSAGES: Record<ScannerUnavailableReason, string> = {
  unsupported: 'This device can’t run the document scanner.',
  'play-services': 'The document scanner needs Google Play services.',
  'not-ready': 'The document scanner isn’t ready yet. It may still be downloading.',
  permission: 'The document scanner has no access to the camera.',
  failed: 'The document scanner couldn’t start.',
};

let scanning = false;

/**
 * Scan a document and open it, or add pages to `documentId`. `navigate` is the router's
 * push. A cancelled scan changes nothing; a scanner that can't start falls back to the
 * built-in camera with a short note.
 */
export async function startScan(navigate: (href: string) => void, documentId?: string): Promise<void> {
  if (!usesSystemScanner()) {
    navigate(cameraHref(documentId));
    return;
  }
  if (scanning) return;
  scanning = true;
  try {
    const scan = await import('@/lib/platform/native/scanner').then(
      (native) => native.scanWithSystemScanner(),
      (err: unknown): SystemScan => {
        console.warn('Document scanner failed to load:', err);
        return { status: 'unavailable', reason: 'failed' };
      }
    );
    if (scan.status === 'cancelled') return;
    if (scan.status === 'unavailable') {
      await alertDialog({
        title: 'Using the built-in camera',
        message: UNAVAILABLE_MESSAGES[scan.reason],
      });
      navigate(cameraHref(documentId));
      return;
    }
    const id = await importScan(scan.pages, documentId);
    // Pages added to a document land on the page the scan started from
    if (!documentId) navigate(docHref(id));
  } catch (err) {
    console.error('Failed to save the scan:', err);
    void alertDialog({ title: 'Couldn’t save the scan', message: 'Please try again.' });
  } finally {
    scanning = false;
  }
}
