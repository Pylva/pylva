import { createRequire } from 'node:module';

const sdk = createRequire(import.meta.url)('./langgraph.cjs') as Record<string, unknown>;

export const withLangGraphControlScope = sdk['withLangGraphControlScope'];
export const PylvaCallbackHandler = sdk['PylvaCallbackHandler'];
export const AsyncPylvaCallbackHandler = sdk['AsyncPylvaCallbackHandler'];
