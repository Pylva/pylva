// Authoritative budget-control wire contract (v1.0).
//
// Requests are strict because their parsed representation is hashed for
// idempotency. Responses deliberately use `object` (rather than
// `strictObject`) so older SDKs can safely ignore additive response fields.

import * as v from 'valibot';
import { ErrorCode } from './errors.js';
import {
  EventStatus,
  Framework,
  STORE_BLANK_STRING_PATTERN,
  STORE_LONE_SURROGATE_PATTERN,
  customerIdSchema,
  modelSchema,
  providerSchema,
  stepNameSchema,
} from './telemetry.js';

export const BUDGET_CONTROL_SCHEMA_VERSION = '1.0' as const;
export const DEFAULT_RESERVATION_TTL_SECONDS = 300 as const;
export const UINT32_MAX = 4_294_967_295 as const;

/** Accepted NUMERIC(38,18) syntax: at most 20 integer and 18 fractional digits. */
export const NUMERIC_38_18_PATTERN = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/;

/** Post-provider cost syntax: NUMERIC(44,18), at most 26 integer and 18 fractional digits. */
export const NUMERIC_44_18_PATTERN = /^(?:0|[1-9][0-9]{0,25})(?:\.[0-9]{1,18})?$/;

export const BudgetControlMode = {
  SHADOW: 'shadow',
  ENFORCE: 'enforce',
} as const;
export type BudgetControlMode = (typeof BudgetControlMode)[keyof typeof BudgetControlMode];

export const ControlledUsageKind = {
  LLM: 'llm',
  TOOL: 'tool',
} as const;
export type ControlledUsageKind = (typeof ControlledUsageKind)[keyof typeof ControlledUsageKind];

export const BudgetReservationState = {
  RESERVED: 'reserved',
  COMMITTED: 'committed',
  RELEASED: 'released',
  UNRESOLVED: 'unresolved',
  REFUSED: 'refused',
} as const;
export type BudgetReservationState =
  (typeof BudgetReservationState)[keyof typeof BudgetReservationState];

export const ReserveDecision = {
  RESERVED: 'reserved',
  DENIED: 'denied',
  BYPASSED: 'bypassed',
  UNAVAILABLE: 'unavailable',
} as const;
export type ReserveDecision = (typeof ReserveDecision)[keyof typeof ReserveDecision];

export const BudgetReleaseReason = {
  PROVIDER_NOT_CALLED: 'provider_not_called',
  PROVIDER_CONFIRMED_UNCHARGED: 'provider_confirmed_uncharged',
} as const;
export type BudgetReleaseReason = (typeof BudgetReleaseReason)[keyof typeof BudgetReleaseReason];

export const BudgetRuleScope = {
  PER_CUSTOMER: 'per_customer',
  POOLED: 'pooled',
} as const;
export type BudgetRuleScope = (typeof BudgetRuleScope)[keyof typeof BudgetRuleScope];

export const BudgetRulePeriod = {
  HOUR: 'hour',
  DAY: 'day',
  WEEK: 'week',
  MONTH: 'month',
} as const;
export type BudgetRulePeriod = (typeof BudgetRulePeriod)[keyof typeof BudgetRulePeriod];

export const BudgetControlWarningCode = {
  ADVISORY_BUDGET_EXCEEDED: 'advisory_budget_exceeded',
} as const;
export type BudgetControlWarningCode =
  (typeof BudgetControlWarningCode)[keyof typeof BudgetControlWarningCode];

export const BudgetBypassReason = {
  CONTROL_DISABLED: 'control_disabled',
  NO_APPLICABLE_BUDGET: 'no_applicable_budget',
  SHADOW_WOULD_ALLOW: 'shadow_would_allow',
  SHADOW_WOULD_DENY: 'shadow_would_deny',
  SHADOW_CONTROL_UNAVAILABLE: 'shadow_control_unavailable',
} as const;
export type BudgetBypassReason = (typeof BudgetBypassReason)[keyof typeof BudgetBypassReason];

export const BudgetUnavailableReason = {
  PRICING_UNAVAILABLE: 'pricing_unavailable',
  USAGE_BOUND_REQUIRED: 'usage_bound_required',
  CONTROL_UNAVAILABLE: 'control_unavailable',
} as const;
export type BudgetUnavailableReason =
  (typeof BudgetUnavailableReason)[keyof typeof BudgetUnavailableReason];

const schemaVersionSchema = v.literal(BUDGET_CONTROL_SCHEMA_VERSION);
const uuidSchema = v.pipe(
  v.string(),
  v.uuid(),
  v.transform((value) => value.toLowerCase()),
);
const timestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check(
    (value) => value[10] === 'T' && value.endsWith('Z'),
    'timestamps must use canonical UTC Z notation',
  ),
  v.check((value) => {
    const fraction = /\.(\d+)(?:Z| ?[+-])/.exec(value)?.[1];
    return fraction === undefined || fraction.length <= 3;
  }, 'fractional seconds must use millisecond precision'),
  v.check((value) => {
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
    if (!dateParts) return false;
    const year = Number(dateParts[1]);
    const month = Number(dateParts[2]);
    const day = Number(dateParts[3]);
    if (year === 0) return false;
    // Date.UTC treats years 0..99 as 1900..1999. setUTCFullYear preserves the
    // four-digit wire year so TypeScript and Python accept the same calendar.
    const calendarDate = new Date(0);
    calendarDate.setUTCHours(0, 0, 0, 0);
    calendarDate.setUTCFullYear(year, month - 1, day);
    return (
      Number.isFinite(Date.parse(value)) &&
      calendarDate.getUTCFullYear() === year &&
      calendarDate.getUTCMonth() === month - 1 &&
      calendarDate.getUTCDate() === day
    );
  }, 'must contain a valid calendar date'),
);
const controlModeSchema = v.picklist([BudgetControlMode.SHADOW, BudgetControlMode.ENFORCE]);
const frameworkSchema = v.picklist([
  Framework.LANGGRAPH,
  Framework.CREWAI,
  Framework.MASTRA,
  Framework.OPENAI_AGENTS,
  Framework.PYDANTIC_AI,
  Framework.NONE,
]);
const providerAttemptStatusSchema = v.picklist([
  EventStatus.SUCCESS,
  EventStatus.FAILURE,
  EventStatus.RETRY,
  EventStatus.ABORTED,
]);
const reservationTtlSecondsSchema = v.pipe(
  v.number(),
  v.finite(),
  v.safeInteger(),
  v.minValue(30),
  v.maxValue(3_600),
);
const uint32Schema = v.pipe(
  v.number(),
  v.finite(),
  v.safeInteger(),
  v.minValue(0),
  v.maxValue(UINT32_MAX),
  // JSON permits a negative-zero number lexeme. It is mathematically zero,
  // and Python's integer normalization emits `0`, so erase JavaScript's
  // observable `-0` sign before hashing or forwarding the parsed request.
  v.transform((value) => (Object.is(value, -0) ? 0 : value)),
);
const nonBlankStoreSafeStringSchema = (maxLength: number) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.check((value) => [...value].length <= maxLength, `must be at most ${maxLength} characters`),
    v.check((value) => !STORE_BLANK_STRING_PATTERN.test(value), 'must not be whitespace-only'),
    v.check(
      (value) => !STORE_LONE_SURROGATE_PATTERN.test(value),
      'must contain valid Unicode scalar values',
    ),
    v.check((value) => !/[\u0000-\u001F\u007F]/.test(value), 'must not contain control characters'),
  );
const costSourceSlugSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(100),
  v.regex(/^[a-z0-9][a-z0-9-]*$/),
);
const toolNameSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(200),
  v.regex(/^[a-zA-Z0-9 _\-.:/]*$/),
);
const metricSchema = nonBlankStoreSafeStringSchema(100);

/**
 * Parses accepted NUMERIC(38,18) syntax and emits one stable hash form
 * without converting through binary floating point.
 */
export const CanonicalDecimalSchema = v.pipe(
  v.string(),
  v.regex(NUMERIC_38_18_PATTERN),
  v.transform((value) =>
    value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value,
  ),
);
export type CanonicalDecimal = v.InferOutput<typeof CanonicalDecimalSchema>;

/**
 * A widened exact cost used only after a provider has run. Pre-dispatch
 * reservations and releasable amounts deliberately remain NUMERIC(38,18).
 */
export const CanonicalPostProviderCostDecimalSchema = v.pipe(
  v.string(),
  v.regex(NUMERIC_44_18_PATTERN),
  v.transform((value) =>
    value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value,
  ),
);
export type CanonicalPostProviderCostDecimal = v.InferOutput<
  typeof CanonicalPostProviderCostDecimalSchema
>;

const BUDGET_DECIMAL_SCALE = 18;
const BUDGET_DECIMAL_FACTOR = 10n ** BigInt(BUDGET_DECIMAL_SCALE);

/** Convert an already-validated canonical decimal into exact fixed-scale units. */
function budgetDecimalUnits(value: CanonicalDecimal | CanonicalPostProviderCostDecimal): bigint {
  const [integerPart = '0', fractionalPart = ''] = value.split('.');
  return (
    BigInt(integerPart) * BUDGET_DECIMAL_FACTOR +
    BigInt(fractionalPart.padEnd(BUDGET_DECIMAL_SCALE, '0'))
  );
}

export const BudgetControlCapabilitiesResponseSchema = v.object({
  schema_version: schemaVersionSchema,
  control_enabled: v.boolean(),
  min_reservation_ttl_seconds: v.literal(30),
  default_reservation_ttl_seconds: v.literal(300),
  max_reservation_ttl_seconds: v.literal(3600),
  server_time: timestampSchema,
});
export type BudgetControlCapabilitiesResponse = v.InferOutput<
  typeof BudgetControlCapabilitiesResponseSchema
>;

const reserveRequestCommonEntries = {
  schema_version: schemaVersionSchema,
  mode: controlModeSchema,
  operation_id: uuidSchema,
  customer_id: customerIdSchema,
  trace_id: uuidSchema,
  span_id: uuidSchema,
  parent_span_id: v.nullable(uuidSchema),
  step_name: v.nullable(stepNameSchema),
  framework: v.optional(frameworkSchema, Framework.NONE),
  reservation_ttl_seconds: v.optional(reservationTtlSecondsSchema, DEFAULT_RESERVATION_TTL_SECONDS),
};

export const LlmReserveUsageRequestSchema = v.strictObject({
  ...reserveRequestCommonEntries,
  kind: v.literal(ControlledUsageKind.LLM),
  provider: providerSchema,
  model: modelSchema,
  estimated_input_tokens: uint32Schema,
  max_output_tokens: uint32Schema,
});

export const ToolReserveUsageRequestSchema = v.strictObject({
  ...reserveRequestCommonEntries,
  kind: v.literal(ControlledUsageKind.TOOL),
  cost_source_slug: costSourceSlugSchema,
  tool_name: toolNameSchema,
  metric: metricSchema,
  maximum_value: CanonicalDecimalSchema,
});

export const ReserveUsageRequestSchema = v.variant('kind', [
  LlmReserveUsageRequestSchema,
  ToolReserveUsageRequestSchema,
]);
export type ReserveUsageRequest = v.InferInput<typeof ReserveUsageRequestSchema>;
export type ParsedReserveUsageRequest = v.InferOutput<typeof ReserveUsageRequestSchema>;

const budgetRuleSnapshotCommonEntries = {
  rule_id: uuidSchema,
  period: v.picklist([
    BudgetRulePeriod.HOUR,
    BudgetRulePeriod.DAY,
    BudgetRulePeriod.WEEK,
    BudgetRulePeriod.MONTH,
  ]),
  period_start: timestampSchema,
  period_end: timestampSchema,
};

export const BudgetRuleSnapshotSchema = v.pipe(
  v.variant('scope', [
    v.object({
      ...budgetRuleSnapshotCommonEntries,
      scope: v.literal(BudgetRuleScope.PER_CUSTOMER),
      customer_id: customerIdSchema,
    }),
    v.object({
      ...budgetRuleSnapshotCommonEntries,
      scope: v.literal(BudgetRuleScope.POOLED),
      customer_id: v.null(),
    }),
  ]),
  v.check(
    (snapshot) => Date.parse(snapshot.period_end) > Date.parse(snapshot.period_start),
    'period_end must be after period_start',
  ),
);
export type BudgetRuleSnapshot = v.InferOutput<typeof BudgetRuleSnapshotSchema>;

export const BudgetControlWarningSchema = v.pipe(
  v.object({
    code: v.literal(BudgetControlWarningCode.ADVISORY_BUDGET_EXCEEDED),
    rule_id: uuidSchema,
    limit_usd: CanonicalDecimalSchema,
    projected_usd: CanonicalDecimalSchema,
  }),
  v.check(
    (warning) => budgetDecimalUnits(warning.projected_usd) > budgetDecimalUnits(warning.limit_usd),
    'projected_usd must exceed limit_usd for an exceeded-budget warning',
  ),
);
export type BudgetControlWarning = v.InferOutput<typeof BudgetControlWarningSchema>;

export const ReservedUsageResponseSchema = v.object({
  schema_version: schemaVersionSchema,
  decision: v.literal(ReserveDecision.RESERVED),
  allowed: v.literal(true),
  decision_id: uuidSchema,
  operation_id: uuidSchema,
  reservation_id: uuidSchema,
  state: v.literal(BudgetReservationState.RESERVED),
  reserved_usd: CanonicalDecimalSchema,
  remaining_usd: v.nullable(CanonicalDecimalSchema),
  expires_at: timestampSchema,
  warnings: v.array(BudgetControlWarningSchema),
});

export const DeniedUsageResponseSchema = v.pipe(
  v.object({
    schema_version: schemaVersionSchema,
    decision: v.literal(ReserveDecision.DENIED),
    allowed: v.literal(false),
    decision_id: uuidSchema,
    operation_id: uuidSchema,
    state: v.literal(BudgetReservationState.REFUSED),
    deciding_rule: BudgetRuleSnapshotSchema,
    committed_usd: CanonicalDecimalSchema,
    reserved_usd: CanonicalDecimalSchema,
    unresolved_usd: CanonicalDecimalSchema,
    requested_usd: CanonicalDecimalSchema,
    limit_usd: CanonicalDecimalSchema,
    remaining_usd: CanonicalDecimalSchema,
    warnings: v.array(BudgetControlWarningSchema),
  }),
  v.check((response) => {
    const protectedBefore =
      budgetDecimalUnits(response.committed_usd) +
      budgetDecimalUnits(response.reserved_usd) +
      budgetDecimalUnits(response.unresolved_usd);
    const requested = budgetDecimalUnits(response.requested_usd);
    const limit = budgetDecimalUnits(response.limit_usd);
    const expectedRemaining = limit > protectedBefore ? limit - protectedBefore : 0n;
    return (
      protectedBefore + requested > limit &&
      budgetDecimalUnits(response.remaining_usd) === expectedRemaining
    );
  }, 'denied response budget arithmetic is inconsistent'),
);

const bypassedUsageResponseCommonEntries = {
  schema_version: schemaVersionSchema,
  decision: v.literal(ReserveDecision.BYPASSED),
  allowed: v.literal(true),
  operation_id: uuidSchema,
  warnings: v.array(BudgetControlWarningSchema),
};

const emptyBudgetControlWarningsSchema = v.pipe(
  v.array(BudgetControlWarningSchema),
  v.maxLength(0, 'warnings require an evaluated allocation'),
);

export const BypassedUsageResponseSchema = v.variant('reason', [
  v.object({
    ...bypassedUsageResponseCommonEntries,
    decision_id: v.null(),
    reason: v.literal(BudgetBypassReason.CONTROL_DISABLED),
    would_have_denied: v.null(),
    warnings: emptyBudgetControlWarningsSchema,
  }),
  v.object({
    ...bypassedUsageResponseCommonEntries,
    decision_id: uuidSchema,
    reason: v.literal(BudgetBypassReason.NO_APPLICABLE_BUDGET),
    would_have_denied: v.null(),
    warnings: emptyBudgetControlWarningsSchema,
  }),
  v.object({
    ...bypassedUsageResponseCommonEntries,
    decision_id: uuidSchema,
    reason: v.literal(BudgetBypassReason.SHADOW_WOULD_ALLOW),
    would_have_denied: v.literal(false),
  }),
  v.object({
    ...bypassedUsageResponseCommonEntries,
    decision_id: uuidSchema,
    reason: v.literal(BudgetBypassReason.SHADOW_WOULD_DENY),
    would_have_denied: v.literal(true),
  }),
  v.object({
    ...bypassedUsageResponseCommonEntries,
    decision_id: v.nullable(uuidSchema),
    reason: v.literal(BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE),
    would_have_denied: v.null(),
    warnings: emptyBudgetControlWarningsSchema,
  }),
]);

export const UnavailableUsageResponseSchema = v.object({
  schema_version: schemaVersionSchema,
  decision: v.literal(ReserveDecision.UNAVAILABLE),
  allowed: v.literal(false),
  decision_id: v.nullable(uuidSchema),
  operation_id: uuidSchema,
  reason: v.picklist([
    BudgetUnavailableReason.PRICING_UNAVAILABLE,
    BudgetUnavailableReason.USAGE_BOUND_REQUIRED,
    BudgetUnavailableReason.CONTROL_UNAVAILABLE,
  ]),
  retryable: v.boolean(),
});

export const ReserveUsageResponseSchema = v.union([
  ReservedUsageResponseSchema,
  DeniedUsageResponseSchema,
  BypassedUsageResponseSchema,
  UnavailableUsageResponseSchema,
]);
export type ReserveUsageResponse = v.InferOutput<typeof ReserveUsageResponseSchema>;

const commitRequestCommonEntries = {
  schema_version: schemaVersionSchema,
  status: providerAttemptStatusSchema,
  latency_ms: uint32Schema,
  stream_aborted: v.boolean(),
};

export const LlmCommitUsageRequestSchema = v.strictObject({
  ...commitRequestCommonEntries,
  kind: v.literal(ControlledUsageKind.LLM),
  actual_input_tokens: uint32Schema,
  actual_output_tokens: uint32Schema,
});

export const ToolCommitUsageRequestSchema = v.strictObject({
  ...commitRequestCommonEntries,
  kind: v.literal(ControlledUsageKind.TOOL),
  actual_value: CanonicalDecimalSchema,
});

export const CommitUsageRequestSchema = v.variant('kind', [
  LlmCommitUsageRequestSchema,
  ToolCommitUsageRequestSchema,
]);
export type CommitUsageRequest = v.InferInput<typeof CommitUsageRequestSchema>;
export type ParsedCommitUsageRequest = v.InferOutput<typeof CommitUsageRequestSchema>;

export const CommitUsageResponseSchema = v.pipe(
  v.object({
    schema_version: schemaVersionSchema,
    state: v.literal(BudgetReservationState.COMMITTED),
    reservation_id: uuidSchema,
    operation_id: uuidSchema,
    reserved_usd: CanonicalDecimalSchema,
    actual_usd: CanonicalPostProviderCostDecimalSchema,
    released_usd: CanonicalDecimalSchema,
    overage_usd: CanonicalPostProviderCostDecimalSchema,
    budget_exceeded_after_commit: v.boolean(),
    committed_at: timestampSchema,
    idempotent_replay: v.boolean(),
    late: v.boolean(),
  }),
  v.check((response) => {
    const reserved = budgetDecimalUnits(response.reserved_usd);
    const actual = budgetDecimalUnits(response.actual_usd);
    const expectedReleased = reserved > actual ? reserved - actual : 0n;
    const expectedOverage = actual > reserved ? actual - reserved : 0n;
    return (
      budgetDecimalUnits(response.released_usd) === expectedReleased &&
      budgetDecimalUnits(response.overage_usd) === expectedOverage
    );
  }, 'commit response settlement arithmetic is inconsistent'),
);
export type CommitUsageResponse = v.InferOutput<typeof CommitUsageResponseSchema>;

export const ReleaseUsageRequestSchema = v.strictObject({
  schema_version: schemaVersionSchema,
  reason: v.picklist([
    BudgetReleaseReason.PROVIDER_NOT_CALLED,
    BudgetReleaseReason.PROVIDER_CONFIRMED_UNCHARGED,
  ]),
});
export type ReleaseUsageRequest = v.InferInput<typeof ReleaseUsageRequestSchema>;

export const ReleaseUsageResponseSchema = v.object({
  schema_version: schemaVersionSchema,
  state: v.literal(BudgetReservationState.RELEASED),
  reservation_id: uuidSchema,
  operation_id: uuidSchema,
  released_usd: CanonicalDecimalSchema,
  released_at: timestampSchema,
  idempotent_replay: v.boolean(),
});
export type ReleaseUsageResponse = v.InferOutput<typeof ReleaseUsageResponseSchema>;

export const ExtendUsageRequestSchema = v.strictObject({
  schema_version: schemaVersionSchema,
  extension_id: uuidSchema,
  extend_by_seconds: reservationTtlSecondsSchema,
});
export type ExtendUsageRequest = v.InferInput<typeof ExtendUsageRequestSchema>;

export const ExtendUsageResponseSchema = v.object({
  schema_version: schemaVersionSchema,
  state: v.literal(BudgetReservationState.RESERVED),
  reservation_id: uuidSchema,
  operation_id: uuidSchema,
  extension_id: uuidSchema,
  expires_at: timestampSchema,
  idempotent_replay: v.boolean(),
});
export type ExtendUsageResponse = v.InferOutput<typeof ExtendUsageResponseSchema>;

const errorCodeSchema = v.picklist([
  ErrorCode.INVALID_API_KEY,
  ErrorCode.WRONG_SCOPE,
  ErrorCode.VALIDATION_ERROR,
  ErrorCode.RESOURCE_NOT_FOUND,
  ErrorCode.RATE_LIMIT_EXCEEDED,
  ErrorCode.INTERNAL_ERROR,
  ErrorCode.IDEMPOTENCY_CONFLICT,
  ErrorCode.RESERVATION_STATE_CONFLICT,
]);

export const BudgetControlErrorResponseSchema = v.object({
  error: v.object({
    type: v.picklist([
      'invalid_request_error',
      'authentication_error',
      'rate_limit_error',
      'api_error',
    ]),
    code: errorCodeSchema,
    message: v.string(),
    param: v.optional(v.string()),
  }),
});
export type BudgetControlErrorResponse = v.InferOutput<typeof BudgetControlErrorResponseSchema>;
