import type { CapacitorConfig } from '@capacitor/cli';

// Native shell around the static export (npm run build:export → out/). See
// docs/native/m0-spike.md for what was verified and what is still open.
const config: CapacitorConfig = {
  appId: 'app.quickscan',
  appName: 'QuickScan',
  webDir: 'out',
  // No webContentsDebuggingEnabled: an explicit true would make release builds inspectable
  // too. Capacitor already enables Web Inspector for Debug builds (ios/debug.xcconfig).
};

export default config;
