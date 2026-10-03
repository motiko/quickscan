import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Live tests call real providers (`npm run test:live`); *.supabase.test.ts need a local stack (`npm run test:supabase`)
    exclude: ['node_modules', 'e2e', '.next', '.claude', '**/*.live.test.ts', '**/*.supabase.test.ts'],
    setupFiles: ['./src/lib/__tests__/setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
