// Telemetry types — spec Section 16 (v1.6) + Section 4.10 validation
// NO cost_usd — enforces "Report Usage, Not Cost" at the type level.

import * as v from 'valibot';

// --- Enums ---

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

// NOTE: InstrumentationTier is intentionally narrow in v1.6. A future proxy tier
// (deferred indefinitely per internal design notes) can be re-added as a new enum
// value and a schema bump to v1.7 without breaking stored events.
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

// --- Valibot Validation Schemas (Section 4.10 constraints) ---

// step_name: max 200 chars, alphanumeric + space/underscore/hyphen/dot/colon/slash. No HTML/control chars.
export const stepNameSchema = v.pipe(
  v.string(),
  v.maxLength(200),
  v.regex(/^[a-zA-Z0-9 _\-.:\/]*$/),
);

export const PROVIDER_MODEL_MAX_LENGTH = 255;

const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/;

const storeSafeProviderModelSchema = v.pipe(
  v.string(),
  v.maxLength(PROVIDER_MODEL_MAX_LENGTH),
  v.check((value) => value.trim().length > 0, 'must not be empty or whitespace-only'),
  v.check((value) => !CONTROL_CHARACTER_RE.test(value), 'must not contain control characters'),
);

// provider/model: exact runtime identifiers, max 255 chars, no blank/control chars.
// Punctuation, spaces, slashes, dots, and Unicode are valid when store-safe.
export const modelSchema = storeSafeProviderModelSchema;

// customer_id: max 255 chars, alphanumeric + underscore/hyphen only
export const customerIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(255),
  v.regex(/^[a-zA-Z0-9_\-]+$/),
);

// tool_name: max 200 chars, same charset as step_name
const toolNameSchema = v.pipe(v.string(), v.maxLength(200), v.regex(/^[a-zA-Z0-9 _\-.:\/]*$/));

export const providerSchema = storeSafeProviderModelSchema;

const statusSchema = v.picklist([
  EventStatus.SUCCESS,
  EventStatus.FAILURE,
  EventStatus.RETRY,
  EventStatus.ABORTED,
]);

const frameworkSchema = v.picklist([
  Framework.LANGGRAPH,
  Framework.CREWAI,
  Framework.MASTRA,
  Framework.OPENAI_AGENTS,
  Framework.PYDANTIC_AI,
  Framework.NONE,
]);

const instrumentationTierSchema = v.picklist([
  InstrumentationTier.SDK_WRAPPER,
  InstrumentationTier.REPORTED,
]);

const costSourceSchema = v.picklist([CostSource.AUTO, CostSource.CONFIGURED]);

const tokenCountSourceSchema = v.picklist([TokenCountSource.EXACT, TokenCountSource.ESTIMATED]);

// UUID v4 validation
const uuidSchema = v.pipe(v.string(), v.uuid());

// Event metadata shape. Arbitrary additional keys are allowed (pass-through),
// but token_count_source has a constrained set so ingest can treat it consistently.
const metadataSchema = v.nullable(
  v.looseObject({
    token_count_source: v.optional(tokenCountSourceSchema),
  }),
);

// --- TelemetryEvent Schema (v1.6) ---

export const TelemetryEventSchema = v.object({
  schema_version: v.literal('1.6'),
  run_id: uuidSchema,
  parent_run_id: v.nullable(uuidSchema),
  trace_id: uuidSchema,
  span_id: uuidSchema,
  parent_span_id: v.nullable(uuidSchema),
  customer_id: customerIdSchema,
  step_name: v.nullable(stepNameSchema),
  model: v.nullable(modelSchema),
  provider: v.nullable(providerSchema),
  tokens_in: v.pipe(v.number(), v.integer(), v.minValue(0)),
  tokens_out: v.pipe(v.number(), v.integer(), v.minValue(0)),
  latency_ms: v.pipe(v.number(), v.integer(), v.minValue(0)),
  tool_name: v.nullable(toolNameSchema),
  status: statusSchema,
  framework: frameworkSchema,
  instrumentation_tier: instrumentationTierSchema,
  cost_source: costSourceSchema,
  metric: v.nullable(v.pipe(v.string(), v.maxLength(200))),
  metric_value: v.nullable(v.number()),
  stream_aborted: v.boolean(),
  abort_savings_usd: v.pipe(v.number(), v.minValue(0)),
  sdk_version: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
  timestamp: v.pipe(v.string(), v.isoTimestamp()),
  metadata: v.optional(metadataSchema),
});

export type TelemetryEvent = v.InferOutput<typeof TelemetryEventSchema>;

// --- Batch Schema (max 100 events) ---

export const TelemetryBatchSchema = v.pipe(
  v.array(TelemetryEventSchema),
  v.minLength(1),
  v.maxLength(100),
);

export type TelemetryBatch = v.InferOutput<typeof TelemetryBatchSchema>;

// --- Ingest Request / Response (wire format v1.6) ---

export const IngestRequestSchema = v.object({
  batch_id: uuidSchema,
  sdk_version: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
  events: TelemetryBatchSchema,
});

export type IngestRequest = v.InferOutput<typeof IngestRequestSchema>;

export const IngestWarningCode = {
  NEEDS_PRICING_INPUT: 'needs_pricing_input',
  PENDING_PRICING: 'pending_pricing',
  CUSTOMER_LIMIT_REACHED: 'customer_limit_reached',
} as const;

export type IngestWarningCode = (typeof IngestWarningCode)[keyof typeof IngestWarningCode];

const ingestWarningCodeSchema = v.picklist([
  IngestWarningCode.NEEDS_PRICING_INPUT,
  IngestWarningCode.PENDING_PRICING,
  IngestWarningCode.CUSTOMER_LIMIT_REACHED,
]);

export const IngestResponseSchema = v.object({
  accepted: v.pipe(v.number(), v.integer(), v.minValue(0)),
  rejected: v.pipe(v.number(), v.integer(), v.minValue(0)),
  errors: v.optional(
    v.array(
      v.object({
        index: v.pipe(v.number(), v.integer(), v.minValue(0)),
        message: v.string(),
      }),
    ),
  ),
  warnings: v.optional(
    v.array(
      v.object({
        event_index: v.pipe(v.number(), v.integer(), v.minValue(0)),
        code: ingestWarningCodeSchema,
        provider: v.optional(v.nullable(v.string())),
        model: v.optional(v.nullable(v.string())),
        metric: v.optional(v.nullable(v.string())),
        message: v.optional(v.string()),
      }),
    ),
  ),
  // B2a I-T3-2: authoritative pre-call flag. Non-empty array means the SDK
  // should bump local accumulators to `limit_usd + 1` so the next pre-call
  // for each (rule_id, customer_id or pooled) key throws.
  budget_exceeded: v.optional(
    v.array(
      v.object({
        rule_id: v.pipe(v.string(), v.uuid()),
        customer_id: v.nullable(v.string()),
        limit_usd: v.number(),
        accumulated_usd: v.number(),
        period: v.picklist(['hour', 'day', 'week', 'month']),
        period_start: v.string(),
      }),
    ),
  ),
});

export type IngestResponse = v.InferOutput<typeof IngestResponseSchema>;
