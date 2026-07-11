import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  // Match Next's automatic JSX runtime so .tsx sources imported by node-env
  // tests (RSC pages) do not need a manual `import * as React` just for tests.
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
    include: ['tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    exclude: [
      'node_modules',
      'dist',
      '.next',
      'tests/security/**',
      'tests/e2e/**',
      'tests/integration/**',
    ],
    testTimeout: 30000,
    passWithNoTests: true,
  },
});
