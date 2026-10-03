import type { CapacitorConfig } from '@capacitor/cli';

// Native shell around the static export (npm run build:export → out/). See
// docs/native/m0-spike.md for what was verified and what is still open.
const config: CapacitorConfig = {
  appId: 'app.quickscan',
  appName: 'QuickScan',
  webDir: 'out',
  ios: {
    // Safari Web Inspector can attach to debug builds.
    webContentsDebuggingEnabled: true,
  },
};

export default config;
