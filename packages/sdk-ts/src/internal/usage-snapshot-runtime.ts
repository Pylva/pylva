// Exact JSON detachment/validation surface needed by the direct OpenAI and
// Anthropic wrappers. The Vercel entry uses the smaller token-bound runtime.

export {
  abortSignalIsAborted,
  assertExactAbortSignal,
  assertJsonSerializationPosture,
  assertNoNestedKeys,
  detachValidatedJson,
  isPlainRecord,
  isProxyObject,
  snapshotOwnDataProperties,
} from '../wrappers/_usage_bound.js';
