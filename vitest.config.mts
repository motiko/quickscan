import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    // Live tests call real providers; run them with `npm run test:live`
    exclude: ['node_modules', 'e2e', '.next', '.claude', '**/*.live.test.ts'],
    setupFiles: ['./src/lib/__tests__/setup.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
