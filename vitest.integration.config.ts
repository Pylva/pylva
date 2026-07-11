import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Integration tests: hit real service containers.
// `pnpm test:integration` runs this config; the default `pnpm test` skips the
// integration directory so unit runs stay fast (see vitest.config.ts).
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup-integration-env.ts'],
    include: ['tests/security/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 30_000,
  },
});
