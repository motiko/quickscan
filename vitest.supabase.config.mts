import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Sync against a local Supabase stack (`npx supabase start`); see sync.supabase.test.ts.
export default defineConfig({
  test: {
    include: ['**/*.supabase.test.ts'],
    exclude: ['node_modules', 'e2e', '.next', '.claude'],
    setupFiles: ['./src/lib/__tests__/setup.ts'],
    testTimeout: 60_000,
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
