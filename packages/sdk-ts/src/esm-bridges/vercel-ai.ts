import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('./vercel-ai.cjs') as Record<string, unknown>;

export const applyVercelAiPatch = sdk['applyVercelAiPatch'];
export const createControlledOpenAIChatModel = sdk['createControlledOpenAIChatModel'];
export const controlledGenerateText = sdk['controlledGenerateText'];
export const controlledStreamText = sdk['controlledStreamText'];
export const PylvaStrictProviderError = sdk['PylvaStrictProviderError'];
