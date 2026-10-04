/*
 * Passkey PRF in the native (Capacitor) app, through ios/App/App/NativePasskeyPlugin.swift.
 * The app's web view runs at capacitor://localhost, where WebAuthn can't use our domain, so
 * passkeys.ts asks iOS directly (ASAuthorization + the associated domain) for the same
 * iCloud Keychain passkeys the website made.
 *
 * Nothing here loads on the web: the Capacitor global only exists inside the app, and
 * @capacitor/core is imported lazily from there.
 */

/** The website's hostname, which is the passkeys' rpId. Must match App.entitlements. */
export const NATIVE_PASSKEY_RP_ID = 'scantab.vercel.app';

export interface NativePrfResult {
  /** Base64url credential id of the passkey the user picked. */
  credentialId: string;
  /** PRF output (secret): the caller zeroes it after use. */
  first: Uint8Array<ArrayBuffer>;
}

interface NativePasskeyPlugin {
  isSupported(): Promise<{ supported: boolean }>;
  getPrf(options: { rpId: string; credentials: { id: string; salt: string }[] }): Promise<{ credentialId: string; first: string }>;
}

/** True inside the iOS/Android app, false in any browser. */
export function isNativeApp(): boolean {
  const capacitor = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return capacitor?.isNativePlatform?.() === true;
}

let plugin: Promise<NativePasskeyPlugin> | null = null;

function nativePasskey(): Promise<NativePasskeyPlugin> {
  plugin ??= import('@capacitor/core').then(({ registerPlugin }) => registerPlugin<NativePasskeyPlugin>('NativePasskey'));
  return plugin;
}

export async function isNativePasskeySupported(): Promise<boolean> {
  return (await (await nativePasskey()).isSupported()).supported;
}

/**
 * One passkey assertion with PRF. `credentials` pairs each allowed credential id (base64url)
 * with its salt (base64). Rejects with a Capacitor error whose `code` is
 * `unsupported | cancelled | not-associated | failed`.
 */
export async function getNativePrf(credentials: { id: string; salt: string }[]): Promise<NativePrfResult> {
  const result = await (await nativePasskey()).getPrf({ rpId: NATIVE_PASSKEY_RP_ID, credentials });
  const binary = atob(result.first);
  const first = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) first[i] = binary.charCodeAt(i);
  return { credentialId: result.credentialId, first };
}
