import type { DocumentScannerPlugin } from '@capgo/capacitor-document-scanner';

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

/** A scanned page, read through the web view's file URL (`Capacitor.convertFileSrc`). */
async function readPage(path: string): Promise<Blob> {
  const capacitor = (globalThis as { Capacitor?: { convertFileSrc?: (path: string) => string } }).Capacitor;
  const url = capacitor?.convertFileSrc?.(path) ?? path;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't read the scanned page (${response.status})`);
  return response.blob();
}

/**
 * Open the system scanner and wait for the user. Resolves with the pages in order, or
 * `cancelled`, or `unavailable` when the scanner couldn't start (the caller falls back to the
 * built-in camera). Rejects only when the scanned pages can't be read.
 */
export async function scanWithSystemScanner(): Promise<SystemScan> {
  let paths: string[];
  try {
    const { native } = await documentScanner();
    // letUserAdjustCrop: false keeps VisionKit's own flow. The plugin's default (true), like
    // a page limit, swizzles private VisionKit classes to force a review after each capture.
    // VisionKit's review already lets the user adjust the crop; ML Kit's always does.
    const response = await native.scanDocument({ letUserAdjustCrop: false });
    if (response.status === 'cancel' || !response.scannedImages?.length) return { status: 'cancelled' };
    paths = response.scannedImages;
  } catch (err) {
    console.warn('System document scanner unavailable:', err);
    return { status: 'unavailable', reason: unavailableReason(err) };
  }
  const pages: Blob[] = [];
  for (const path of paths) pages.push(await readPage(path));
  return { status: 'scanned', pages };
}
