import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Credentials for live tests come from .env.test.local locally (gitignored) and from
// GitHub Actions secrets in CI. Tests skip themselves when their key is missing.
if (existsSync('.env.test.local')) process.loadEnvFile('.env.test.local');

export default defineConfig({
  test: {
    include: ['**/*.live.test.ts'],
    exclude: ['node_modules', 'e2e', '.next', '.claude'],
    setupFiles: ['./src/lib/__tests__/setup.ts'],
    testTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
