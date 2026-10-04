import type { DocumentScannerPlugin, ResponseType } from '@capgo/capacitor-document-scanner';

/*
 * The system document scanner through @capgo/capacitor-document-scanner: VisionKit's document
 * camera in the iOS app, ML Kit Document Scanner (Google Play services) in the Android app.
 * Both find the page, crop it, fix the perspective and take several pages in one go. Only
 * loaded inside the app, from platform/scanner.ts.
 */

export type ScannerUnavailableReason = 'unsupported' | 'play-services' | 'not-ready' | 'permission' | 'failed';

export type SystemScan =
  | { status: 'scanned'; pages: Blob[] }
  | { status: 'cancelled' }
  | { status: 'unavailable'; reason: ScannerUnavailableReason };

// Boxed: a Capacitor plugin proxy answers every property, `then` included, so a promise
// resolving to it would call a native "then" method that never answers.
let plugin: Promise<{ native: DocumentScannerPlugin }> | null = null;

function documentScanner(): Promise<{ native: DocumentScannerPlugin }> {
  plugin ??= import('@capgo/capacitor-document-scanner').then(({ DocumentScanner }) => ({ native: DocumentScanner }));
  return plugin;
}

/**
 * Why the scanner didn't start. The plugin rejects with plain messages, no codes: ML Kit
 * refuses emulators and devices without Play services, and fails to start while Play services
 * is still downloading its scanner module; VisionKit refuses devices without a camera.
 */
export function unavailableReason(err: unknown): ScannerUnavailableReason {
  const message = err instanceof Error ? err.message : String(err);
  if (/permission|denied|not authori[sz]ed/i.test(message)) return 'permission';
  if (/Google Play Services/i.test(message)) return 'play-services';
  if (/not supported|emulator/i.test(message)) return 'unsupported';
  if (/Unable to start/i.test(message)) return 'not-ready';
  return 'failed';
}

/** A page as the plugin returns it (base64 JPEG) → Blob. */
function decodePage(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/jpeg' });
}

/**
 * Open the system scanner and wait for the user. Resolves with the pages in order, or
 * `cancelled`, or `unavailable` when the scanner couldn't start (the caller falls back to the
 * built-in camera).
 */
export async function scanWithSystemScanner(): Promise<SystemScan> {
  let images: string[];
  try {
    const { native } = await documentScanner();
    const response = await native.scanDocument({
      // letUserAdjustCrop: false keeps VisionKit's own flow. The plugin's default (true), like
      // a page limit, swizzles private VisionKit classes to force a review after each capture.
      // VisionKit's review already lets the user adjust the crop; ML Kit's always does.
      letUserAdjustCrop: false,
      // Base64 rather than file paths: on iOS the plugin writes each page to Documents/ and
      // never deletes it (≈1.5 MB a page, backed up to iCloud); the app has no file plugin
      // to clean up after it.
      responseType: 'base64' as ResponseType,
    });
    if (response.status === 'cancel' || !response.scannedImages?.length) return { status: 'cancelled' };
    images = response.scannedImages;
  } catch (err) {
    console.warn('System document scanner unavailable:', err);
    return { status: 'unavailable', reason: unavailableReason(err) };
  }
  return { status: 'scanned', pages: images.map(decodePage) };
}
