import { defineConfig } from 'tsup';
import {
  canonicalBudgetExternalPlugin,
  canonicalControlExternalPlugin,
  canonicalRoutingExternalPlugin,
  canonicalRuntimeExternalPlugin,
  canonicalTelemetryExternalPlugin,
  canonicalWrapperExternalPlugin,
  runtimeBuildBase,
} from './tsup.shared.js';

export default defineConfig({
  ...runtimeBuildBase,
  entry: {
    openai: 'src/internal/openai-public.ts',
    anthropic: 'src/internal/anthropic-public.ts',
    'vercel-ai': 'src/internal/vercel-ai-public.ts',
  },
  format: ['cjs'],
  dts: false,
  clean: false,
  esbuildPlugins: [
    canonicalRuntimeExternalPlugin,
    canonicalTelemetryExternalPlugin,
    canonicalBudgetExternalPlugin,
    canonicalRoutingExternalPlugin,
    canonicalControlExternalPlugin,
    canonicalWrapperExternalPlugin,
  ],
});
