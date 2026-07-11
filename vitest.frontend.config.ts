import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Frontend component tests: jsdom env + @testing-library/react. Kept in a
// separate config so the default `pnpm test` stays Node-only and fast.
// Run via `pnpm test:frontend`.
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
    environment: 'jsdom',
    include: ['tests/frontend/**/*.test.tsx'],
    setupFiles: ['./tests/setup-react.ts'],
    testTimeout: 15_000,
  },
});
