import type { CapacitorConfig } from '@capacitor/cli';

// Native shell around the static export (npm run build:export → out/). See
// docs/native/m0-spike.md for what was verified and what is still open.
const config: CapacitorConfig = {
  appId: 'app.quickscan',
  appName: 'QuickScan',
  webDir: 'out',
  // Capacitor's default ('debug') prints every plugin result to the Xcode and JS consoles in
  // Debug builds, and NativePasskey returns a PRF output, the secret that unwraps the vault key.
  loggingBehavior: 'none',
  // No webContentsDebuggingEnabled: an explicit true would make release builds inspectable
  // too. Capacitor already enables Web Inspector for Debug builds (ios/debug.xcconfig).
};

export default config;
