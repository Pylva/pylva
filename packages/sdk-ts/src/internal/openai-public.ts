// Published OpenAI surface. Test resetters and the legacy unwrap helper stay
// source-internal and are deliberately absent from both ESM and CommonJS.

export { applyOpenAiPatch, PylvaStrictProviderError, wrapOpenAI } from '../wrappers/openai.js';
export type { ControlledOpenAIClient, StrictOpenAIOptions } from '../wrappers/openai.js';
