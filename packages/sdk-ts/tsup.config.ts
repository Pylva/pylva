import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    openai: 'src/internal/openai-public.ts',
    anthropic: 'src/internal/anthropic-public.ts',
    'vercel-ai': 'src/internal/vercel-ai-public.ts',
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
  // uninstallable (EUNSUPPORTEDPROTOCOL). This declaration-producing phase
  // leaves valibot external because inlining its generics breaks the d.ts
  // bundle (dangling ./types/index.js specifiers). The canonical runtime
  // phases bundle the exact tree-shaken valibot implementation.
  noExternal: [
    '@pylva/shared',
    '@pylva/shared/telemetry',
    '@pylva/shared/telemetry-values',
    '@pylva/shared/budget-errors',
    '@pylva/shared/budget-control',
    '@pylva/shared/errors',
    '@pylva/shared/rules',
    '@pylva/shared/cost-sources',
  ],
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
      paths: {
        '@pylva/shared': ['../shared/src/index.ts'],
        '@pylva/shared/telemetry': ['../shared/src/types/telemetry.ts'],
        '@pylva/shared/telemetry-values': ['../shared/src/types/telemetry-values.ts'],
        '@pylva/shared/budget-errors': ['../shared/src/errors/budget.ts'],
        '@pylva/shared/budget-control': ['../shared/src/types/budget-control.ts'],
        '@pylva/shared/errors': ['../shared/src/types/errors.ts'],
        '@pylva/shared/rules': ['../shared/src/types/rules.ts'],
        '@pylva/shared/cost-sources': ['../shared/src/types/cost-sources.ts'],
      },
    },
  },
  tsconfig: './tsconfig.build.json',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Runtime JavaScript is minified once, after every canonical phase, by
  // scripts/build.mjs so Terser can chain the final source maps exactly.
  minify: false,
  target: 'node20',
  treeshake: true,
});
