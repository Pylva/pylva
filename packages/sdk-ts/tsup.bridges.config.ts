import { defineConfig } from 'tsup';
import { runtimeBuildBase } from './tsup.shared.js';

export default defineConfig({
  ...runtimeBuildBase,
  entry: {
    index: 'src/esm-bridges/index.ts',
    openai: 'src/esm-bridges/openai.ts',
    anthropic: 'src/esm-bridges/anthropic.ts',
    'vercel-ai': 'src/esm-bridges/vercel-ai.ts',
    langgraph: 'src/esm-bridges/langgraph.ts',
  },
  format: ['esm'],
  dts: false,
  clean: false,
});
