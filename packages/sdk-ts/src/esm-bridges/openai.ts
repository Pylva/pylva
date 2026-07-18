import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('./openai.cjs') as Record<string, unknown>;

export const applyOpenAiPatch = sdk['applyOpenAiPatch'];
export const wrapOpenAI = sdk['wrapOpenAI'];
export const PylvaStrictProviderError = sdk['PylvaStrictProviderError'];
