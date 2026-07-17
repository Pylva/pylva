import { defineConfig } from 'tsup';
import {
  canonicalBudgetExternalPlugin,
  canonicalRoutingExternalPlugin,
  canonicalRuntimeExternalPlugin,
  canonicalWrapperExternalPlugin,
  runtimeBuildBase,
} from './tsup.shared.js';

const cjs = {
  ...runtimeBuildBase,
  format: ['cjs'] as const,
  dts: false,
  clean: false,
};

export default defineConfig([
  {
    ...cjs,
    entry: {
      'internal/core-runtime': 'src/internal/core-runtime.ts',
      'internal/execution-runtime': 'src/internal/execution-runtime.ts',
      'internal/public-errors': 'src/internal/public-errors.ts',
    },
    esbuildPlugins: [canonicalRuntimeExternalPlugin],
  },
  {
    ...cjs,
    entry: { 'internal/budget-runtime': 'src/internal/budget-runtime.ts' },
    esbuildPlugins: [canonicalRuntimeExternalPlugin],
  },
  {
    ...cjs,
    entry: { 'internal/routing-runtime': 'src/internal/routing-runtime.ts' },
    esbuildPlugins: [canonicalRuntimeExternalPlugin, canonicalBudgetExternalPlugin],
  },
  {
    ...cjs,
    entry: { 'internal/nonllm-runtime': 'src/internal/nonllm-runtime.ts' },
    esbuildPlugins: [canonicalRuntimeExternalPlugin],
  },
  {
    ...cjs,
    entry: { 'internal/telemetry-runtime': 'src/internal/telemetry-runtime.ts' },
    esbuildPlugins: [canonicalRuntimeExternalPlugin, canonicalBudgetExternalPlugin],
  },
  {
    ...cjs,
    entry: { 'internal/control-runtime': 'src/internal/control-runtime.ts' },
    esbuildPlugins: [canonicalRuntimeExternalPlugin],
  },
  {
    ...cjs,
    entry: {
      'internal/engine-runtime': 'src/internal/engine-runtime.ts',
      'internal/budget-enforcement-runtime': 'src/internal/budget-enforcement-runtime.ts',
    },
    esbuildPlugins: [
      canonicalRuntimeExternalPlugin,
      canonicalBudgetExternalPlugin,
      canonicalRoutingExternalPlugin,
      canonicalWrapperExternalPlugin,
    ],
  },
  {
    ...cjs,
    entry: {
      'internal/usage-snapshot-runtime': 'src/internal/usage-snapshot-runtime.ts',
    },
    esbuildPlugins: [canonicalRuntimeExternalPlugin, canonicalWrapperExternalPlugin],
  },
  {
    ...cjs,
    entry: { 'internal/init-validation-runtime': 'src/internal/init-validation-runtime.ts' },
    esbuildPlugins: [
      canonicalRuntimeExternalPlugin,
      canonicalBudgetExternalPlugin,
      canonicalRoutingExternalPlugin,
    ],
  },
  {
    ...cjs,
    entry: { 'internal/strict-unwrapper-runtime': 'src/internal/strict-unwrapper-runtime.ts' },
    esbuildPlugins: [canonicalRuntimeExternalPlugin, canonicalWrapperExternalPlugin],
  },
]);
