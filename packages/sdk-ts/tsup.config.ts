import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    openai: 'src/wrappers/openai.ts',
    anthropic: 'src/wrappers/anthropic.ts',
    'vercel-ai': 'src/wrappers/vercel-ai.ts',
    langgraph: 'src/langgraph.ts',
    'cli/validate': 'src/cli/validate.ts',
    'cli/approve': 'src/cli/approve.ts',
    'cli/ci-check': 'src/cli/ci-check.ts',
    'cli/scanner': 'src/cli/scanner.ts',
    'cli/slugify': 'src/cli/slugify.ts',
    'cli/known-apis': 'src/cli/known-apis.ts',
  },
  format: ['esm', 'cjs'],
  // Provides import.meta.url in the CJS build (used by wrappers/_load.ts to
  // resolve peer deps relative to the installed package).
  shims: true,
  // Bundle the private workspace package into dist. package.json must NOT
  // list @pylva/shared in "dependencies": npm publish ships the manifest
  // verbatim (no workspace:* rewrite), which would make the package
  // uninstallable (EUNSUPPORTEDPROTOCOL). valibot stays external — it is a
  // declared runtime dependency, and inlining its generics breaks the d.ts
  // bundle (dangling ./types/index.js specifiers).
  noExternal: ['@pylva/shared'],
  dts: {
    // Inline @pylva/shared into the d.ts bundle. The paths alias makes
    // the dts rollup treat shared as local source (its whole relative import
    // graph gets bundled); plain `resolve` stopped at the barrel re-export
    // and left dangling './types/index.js' specifiers. rootDir lifts to the
    // repo root because shared's realpath (packages/shared/src) sits outside
    // this package. The JS build is unaffected.
    compilerOptions: {
      rootDir: '../..',
      baseUrl: '.',
      paths: { '@pylva/shared': ['../shared/src/index.ts'] },
    },
  },
  tsconfig: './tsconfig.build.json',
  clean: true,
  sourcemap: true,
  splitting: false,
  minify: false,
  target: 'node18',
  treeshake: true,
});
