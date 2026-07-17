import { defineConfig } from 'tsup';
import {
  canonicalBudgetExternalPlugin,
  canonicalControlExternalPlugin,
  canonicalNonLlmExternalPlugin,
  canonicalProviderExternalPlugin,
  canonicalRuntimeExternalPlugin,
  canonicalRoutingExternalPlugin,
  canonicalTelemetryExternalPlugin,
  canonicalWrapperExternalPlugin,
  runtimeBuildBase,
} from './tsup.shared.js';

export default defineConfig({
  ...runtimeBuildBase,
  entry: {
    index: 'src/index.ts',
    langgraph: 'src/langgraph.ts',
  },
  format: ['cjs'],
  dts: false,
  clean: false,
  esbuildPlugins: [
    canonicalRuntimeExternalPlugin,
    canonicalTelemetryExternalPlugin,
    canonicalBudgetExternalPlugin,
    canonicalRoutingExternalPlugin,
    canonicalNonLlmExternalPlugin,
    canonicalControlExternalPlugin,
    canonicalWrapperExternalPlugin,
    canonicalProviderExternalPlugin,
  ],
});
