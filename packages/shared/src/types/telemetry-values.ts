// Runtime telemetry constants with no validation dependency. Lightweight SDK
// entrypoints import this module so they do not pull Valibot/schema
// initialization into provider wrappers or callbacks.

export const Provider = {
  OPENAI: 'openai',
  ANTHROPIC: 'anthropic',
  GOOGLE: 'google',
  DEEPSEEK: 'deepseek',
  MISTRAL: 'mistral',
  COHERE: 'cohere',
  OTHER: 'other',
} as const;

// Non-exhaustive convenience constants. Runtime telemetry may use any
// store-safe provider identifier emitted by an SDK/runtime.
export type Provider = string;

export const EventStatus = {
  SUCCESS: 'success',
  FAILURE: 'failure',
  RETRY: 'retry',
  ABORTED: 'aborted',
} as const;

export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

export const Framework = {
  LANGGRAPH: 'langgraph',
  CREWAI: 'crewai',
  MASTRA: 'mastra',
  OPENAI_AGENTS: 'openai-agents',
  PYDANTIC_AI: 'pydantic-ai',
  NONE: 'none',
} as const;

export type Framework = (typeof Framework)[keyof typeof Framework];

// NOTE: InstrumentationTier is intentionally narrow in v1.6. A future proxy
// tier can be added with a schema bump without changing this module boundary.
export const InstrumentationTier = {
  SDK_WRAPPER: 'sdk_wrapper',
  REPORTED: 'reported',
} as const;

export type InstrumentationTier = (typeof InstrumentationTier)[keyof typeof InstrumentationTier];

export const TokenCountSource = {
  EXACT: 'exact',
  ESTIMATED: 'estimated',
} as const;

export type TokenCountSource = (typeof TokenCountSource)[keyof typeof TokenCountSource];

export const CostSource = {
  AUTO: 'auto',
  CONFIGURED: 'configured',
} as const;

export type CostSource = (typeof CostSource)[keyof typeof CostSource];
