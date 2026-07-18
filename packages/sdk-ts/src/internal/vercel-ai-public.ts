// Published Vercel AI surface. The patch resetter is test-only and must not
// become a capability on the installed package.

export {
  applyVercelAiPatch,
  createControlledOpenAIChatModel,
  controlledGenerateText,
  controlledStreamText,
  PylvaStrictProviderError,
} from '../wrappers/vercel-ai.js';
export type {
  ControlledOpenAIChatModel,
  ControlledOpenAIChatModelOptions,
} from '../wrappers/vercel-ai.js';
