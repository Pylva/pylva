import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('./anthropic.cjs') as Record<string, unknown>;

export const applyAnthropicPatch = sdk['applyAnthropicPatch'];
export const wrapAnthropic = sdk['wrapAnthropic'];
export const PylvaStrictProviderError = sdk['PylvaStrictProviderError'];
