import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@cursor/sdk': fileURLToPath(new URL('./test/fixtures/cursor-sdk-stub.ts', import.meta.url)),
    },
  },
});
