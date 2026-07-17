// Compact, descriptor-safe authoritative-control wire parsing.
//
// The shared package remains the contract authority and supplies these types,
// but dispatch must not initialize its full Valibot graph at runtime. Keep the
// rules below in lockstep with packages/shared/src/types/budget-control.ts; the
// SDK golden-corpus test replays every shared fixture through this parser.

import { isProxy } from 'node:util/types';
import type {
  BudgetControlCapabilitiesResponse,
  BudgetControlErrorResponse,
  CommitUsageResponse,
  ExtendUsageRequest,
  ExtendUsageResponse,
  ParsedCommitUsageRequest,
  ParsedReserveUsageRequest,
  ReleaseUsageRequest,
  ReleaseUsageResponse,
  ReserveUsageResponse,
} from '@pylva/shared/budget-control';

const INVALID = Symbol('invalid-control-wire');
const SCHEMA_VERSION = '1.0';
const UINT32_MAX = 4_294_967_295;
const DEFAULT_TTL_SECONDS = 300;
const UUID_PATTERN = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const TIMESTAMP_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:[12]\d|0[1-9]|3[01])T(?:0\d|1\d|2[0-3])(?::[0-5]\d){2}(?:\.\d{1,3})?Z$/u;
const DECIMAL_38_18_PATTERN = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/;
const DECIMAL_44_18_PATTERN = /^(?:0|[1-9][0-9]{0,25})(?:\.[0-9]{1,18})?$/;
const BLANK_PATTERN =
  /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$/u;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/;
const CUSTOMER_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const STEP_OR_TOOL_PATTERN = /^[a-zA-Z0-9 _\-.:/]*$/;
const COST_SOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const DECIMAL_SCALE = 18;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

type SafeRecord = Record<string, unknown>;

function reject(): never {
  throw INVALID;
}

function attempt<T>(parse: () => T): T | null {
  try {
    return parse();
  } catch {
    return null;
  }
}

function record(value: unknown, exactKeys?: readonly string[]): SafeRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value))
    reject();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) reject();
  if (exactKeys !== undefined) {
    for (const key of keys as string[]) if (!exactKeys.includes(key)) reject();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const output = Object.create(null) as SafeRecord;
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      reject();
    }
    output[key] = descriptor.value;
  }
  return output;
}

function denseArray(value: unknown): unknown[] {
  if (typeof value !== 'object' || value === null || isProxy(value) || !Array.isArray(value))
    reject();
  if (Object.getPrototypeOf(value) !== Array.prototype) reject();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) reject();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  const lengthDescriptor = descriptors['length'];
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number'
  ) {
    reject();
  }
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) reject();
  const output: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      descriptor.get !== undefined ||
      descriptor.set !== undefined ||
      !('value' in descriptor)
    ) {
      reject();
    }
    output.push(descriptor.value);
  }
  return output;
}

function exactKeys(value: SafeRecord, keys: readonly string[]): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) reject();
}

function string(value: unknown): string {
  if (typeof value !== 'string') reject();
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') reject();
  return value;
}

function literal<T extends string | number | boolean | null>(value: unknown, expected: T): T {
  if (value !== expected) reject();
  return expected;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== 'string' || !choices.includes(value)) reject();
  return value as T[number];
}

function uuid(value: unknown): string {
  const parsed = string(value);
  if (!UUID_PATTERN.test(parsed)) reject();
  return parsed.toLowerCase();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function timestamp(value: unknown): string {
  const parsed = string(value);
  if (!TIMESTAMP_PATTERN.test(parsed)) reject();
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(parsed);
  if (parts === null) reject();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (year === 0) reject();
  const calendarDate = new Date(0);
  calendarDate.setUTCHours(0, 0, 0, 0);
  calendarDate.setUTCFullYear(year, month - 1, day);
  if (
    !Number.isFinite(Date.parse(parsed)) ||
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day
  ) {
    reject();
  }
  return parsed;
}

function safeInteger(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    reject();
  }
  return Object.is(value, -0) ? 0 : value;
}

function uint32(value: unknown): number {
  return safeInteger(value, 0, UINT32_MAX);
}

function ttl(value: unknown): number {
  return safeInteger(value, 30, 3_600);
}

function canonicalDecimal(value: unknown, widened = false): string {
  const parsed = string(value);
  if (!(widened ? DECIMAL_44_18_PATTERN : DECIMAL_38_18_PATTERN).test(parsed)) reject();
  return parsed.includes('.') ? parsed.replace(/0+$/, '').replace(/\.$/, '') : parsed;
}

function decimalUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * DECIMAL_FACTOR + BigInt(fraction.padEnd(DECIMAL_SCALE, '0'));
}

function customerId(value: unknown): string {
  const parsed = string(value);
  if (parsed.length < 1 || parsed.length > 255 || !CUSTOMER_ID_PATTERN.test(parsed)) reject();
  return parsed;
}

function stepName(value: unknown): string | null {
  if (value === null) return null;
  const parsed = string(value);
  if (parsed.length > 200 || !STEP_OR_TOOL_PATTERN.test(parsed)) reject();
  return parsed;
}

function storeSafe(value: unknown, maximumCodePoints: number): string {
  const parsed = string(value);
  if (
    [...parsed].length > maximumCodePoints ||
    BLANK_PATTERN.test(parsed) ||
    LONE_SURROGATE_PATTERN.test(parsed) ||
    CONTROL_CHARACTER_PATTERN.test(parsed)
  ) {
    reject();
  }
  return parsed;
}

function costSourceSlug(value: unknown): string {
  const parsed = string(value);
  if (parsed.length < 1 || parsed.length > 100 || !COST_SOURCE_SLUG_PATTERN.test(parsed)) reject();
  return parsed;
}

function toolName(value: unknown): string {
  const parsed = string(value);
  if (parsed.length < 1 || parsed.length > 200 || !STEP_OR_TOOL_PATTERN.test(parsed)) reject();
  return parsed;
}

function schemaVersion(value: unknown): '1.0' {
  return literal(value, SCHEMA_VERSION);
}

function parseWarning(value: unknown) {
  const input = record(value);
  const limit = canonicalDecimal(input['limit_usd']);
  const projected = canonicalDecimal(input['projected_usd']);
  if (decimalUnits(projected) <= decimalUnits(limit)) reject();
  return {
    code: literal(input['code'], 'advisory_budget_exceeded'),
    rule_id: uuid(input['rule_id']),
    limit_usd: limit,
    projected_usd: projected,
  };
}

function parseWarnings(value: unknown) {
  return denseArray(value).map(parseWarning);
}

function parseReserveRequestInternal(value: unknown): ParsedReserveUsageRequest {
  const input = record(value);
  const kind = oneOf(input['kind'], ['llm', 'tool'] as const);
  exactKeys(
    input,
    kind === 'llm'
      ? [
          'schema_version',
          'mode',
          'operation_id',
          'customer_id',
          'trace_id',
          'span_id',
          'parent_span_id',
          'step_name',
          'framework',
          'reservation_ttl_seconds',
          'kind',
          'provider',
          'model',
          'estimated_input_tokens',
          'max_output_tokens',
        ]
      : [
          'schema_version',
          'mode',
          'operation_id',
          'customer_id',
          'trace_id',
          'span_id',
          'parent_span_id',
          'step_name',
          'framework',
          'reservation_ttl_seconds',
          'kind',
          'cost_source_slug',
          'tool_name',
          'metric',
          'maximum_value',
        ],
  );
  const common = {
    schema_version: schemaVersion(input['schema_version']),
    mode: oneOf(input['mode'], ['shadow', 'enforce'] as const),
    operation_id: uuid(input['operation_id']),
    customer_id: customerId(input['customer_id']),
    trace_id: uuid(input['trace_id']),
    span_id: uuid(input['span_id']),
    parent_span_id: nullableUuid(input['parent_span_id']),
    step_name: stepName(input['step_name']),
    framework:
      input['framework'] === undefined
        ? ('none' as const)
        : oneOf(input['framework'], [
            'langgraph',
            'crewai',
            'mastra',
            'openai-agents',
            'pydantic-ai',
            'none',
          ] as const),
    reservation_ttl_seconds:
      input['reservation_ttl_seconds'] === undefined
        ? DEFAULT_TTL_SECONDS
        : ttl(input['reservation_ttl_seconds']),
  };
  return kind === 'llm'
    ? {
        ...common,
        kind,
        provider: storeSafe(input['provider'], 255),
        model: storeSafe(input['model'], 255),
        estimated_input_tokens: uint32(input['estimated_input_tokens']),
        max_output_tokens: uint32(input['max_output_tokens']),
      }
    : {
        ...common,
        kind,
        cost_source_slug: costSourceSlug(input['cost_source_slug']),
        tool_name: toolName(input['tool_name']),
        metric: storeSafe(input['metric'], 100),
        maximum_value: canonicalDecimal(input['maximum_value']),
      };
}

function parseCommitRequestInternal(value: unknown): ParsedCommitUsageRequest {
  const input = record(value);
  const kind = oneOf(input['kind'], ['llm', 'tool'] as const);
  exactKeys(
    input,
    kind === 'llm'
      ? [
          'schema_version',
          'status',
          'latency_ms',
          'stream_aborted',
          'kind',
          'actual_input_tokens',
          'actual_output_tokens',
        ]
      : ['schema_version', 'status', 'latency_ms', 'stream_aborted', 'kind', 'actual_value'],
  );
  const common = {
    schema_version: schemaVersion(input['schema_version']),
    status: oneOf(input['status'], ['success', 'failure', 'retry', 'aborted'] as const),
    latency_ms: uint32(input['latency_ms']),
    stream_aborted: boolean(input['stream_aborted']),
  };
  return kind === 'llm'
    ? {
        ...common,
        kind,
        actual_input_tokens: uint32(input['actual_input_tokens']),
        actual_output_tokens: uint32(input['actual_output_tokens']),
      }
    : {
        ...common,
        kind,
        actual_value: canonicalDecimal(input['actual_value']),
      };
}

function parseRuleSnapshot(value: unknown) {
  const input = record(value);
  const scope = oneOf(input['scope'], ['per_customer', 'pooled'] as const);
  const start = timestamp(input['period_start']);
  const end = timestamp(input['period_end']);
  if (Date.parse(end) <= Date.parse(start)) reject();
  const common = {
    rule_id: uuid(input['rule_id']),
    period: oneOf(input['period'], ['hour', 'day', 'week', 'month'] as const),
    period_start: start,
    period_end: end,
  };
  return scope === 'per_customer'
    ? { ...common, scope, customer_id: customerId(input['customer_id']) }
    : { ...common, scope, customer_id: literal(input['customer_id'], null) };
}

function parseReserveResponseInternal(value: unknown): ReserveUsageResponse {
  const input = record(value);
  const decision = oneOf(input['decision'], [
    'reserved',
    'denied',
    'bypassed',
    'unavailable',
  ] as const);
  const version = schemaVersion(input['schema_version']);
  const operationId = uuid(input['operation_id']);
  if (decision === 'reserved') {
    return {
      schema_version: version,
      decision,
      allowed: literal(input['allowed'], true),
      decision_id: uuid(input['decision_id']),
      operation_id: operationId,
      reservation_id: uuid(input['reservation_id']),
      state: literal(input['state'], 'reserved'),
      reserved_usd: canonicalDecimal(input['reserved_usd']),
      remaining_usd:
        input['remaining_usd'] === null ? null : canonicalDecimal(input['remaining_usd']),
      expires_at: timestamp(input['expires_at']),
      warnings: parseWarnings(input['warnings']),
    };
  }
  if (decision === 'denied') {
    const committed = canonicalDecimal(input['committed_usd']);
    const reserved = canonicalDecimal(input['reserved_usd']);
    const unresolved = canonicalDecimal(input['unresolved_usd']);
    const requested = canonicalDecimal(input['requested_usd']);
    const limit = canonicalDecimal(input['limit_usd']);
    const remaining = canonicalDecimal(input['remaining_usd']);
    const protectedBefore =
      decimalUnits(committed) + decimalUnits(reserved) + decimalUnits(unresolved);
    const limitUnits = decimalUnits(limit);
    const expectedRemaining = limitUnits > protectedBefore ? limitUnits - protectedBefore : 0n;
    if (
      protectedBefore + decimalUnits(requested) <= limitUnits ||
      decimalUnits(remaining) !== expectedRemaining
    ) {
      reject();
    }
    return {
      schema_version: version,
      decision,
      allowed: literal(input['allowed'], false),
      decision_id: uuid(input['decision_id']),
      operation_id: operationId,
      state: literal(input['state'], 'refused'),
      deciding_rule: parseRuleSnapshot(input['deciding_rule']),
      committed_usd: committed,
      reserved_usd: reserved,
      unresolved_usd: unresolved,
      requested_usd: requested,
      limit_usd: limit,
      remaining_usd: remaining,
      warnings: parseWarnings(input['warnings']),
    };
  }
  if (decision === 'bypassed') {
    const reason = oneOf(input['reason'], [
      'control_disabled',
      'no_applicable_budget',
      'shadow_would_allow',
      'shadow_would_deny',
      'shadow_control_unavailable',
    ] as const);
    const warnings = parseWarnings(input['warnings']);
    let decisionId: string | null;
    let wouldHaveDenied: boolean | null;
    if (reason === 'control_disabled') {
      decisionId = literal(input['decision_id'], null);
      wouldHaveDenied = literal(input['would_have_denied'], null);
      if (warnings.length !== 0) reject();
    } else if (reason === 'no_applicable_budget') {
      decisionId = uuid(input['decision_id']);
      wouldHaveDenied = literal(input['would_have_denied'], null);
      if (warnings.length !== 0) reject();
    } else if (reason === 'shadow_would_allow') {
      decisionId = uuid(input['decision_id']);
      wouldHaveDenied = literal(input['would_have_denied'], false);
    } else if (reason === 'shadow_would_deny') {
      decisionId = uuid(input['decision_id']);
      wouldHaveDenied = literal(input['would_have_denied'], true);
    } else {
      decisionId = nullableUuid(input['decision_id']);
      wouldHaveDenied = literal(input['would_have_denied'], null);
      if (warnings.length !== 0) reject();
    }
    return {
      schema_version: version,
      decision,
      allowed: literal(input['allowed'], true),
      decision_id: decisionId,
      operation_id: operationId,
      reason,
      would_have_denied: wouldHaveDenied,
      warnings,
    } as ReserveUsageResponse;
  }
  return {
    schema_version: version,
    decision,
    allowed: literal(input['allowed'], false),
    decision_id: nullableUuid(input['decision_id']),
    operation_id: operationId,
    reason: oneOf(input['reason'], [
      'pricing_unavailable',
      'usage_bound_required',
      'control_unavailable',
    ] as const),
    retryable: boolean(input['retryable']),
  };
}

function parseCommitResponseInternal(value: unknown): CommitUsageResponse {
  const input = record(value);
  const reserved = canonicalDecimal(input['reserved_usd']);
  const actual = canonicalDecimal(input['actual_usd'], true);
  const released = canonicalDecimal(input['released_usd']);
  const overage = canonicalDecimal(input['overage_usd'], true);
  const reservedUnits = decimalUnits(reserved);
  const actualUnits = decimalUnits(actual);
  const expectedReleased = reservedUnits > actualUnits ? reservedUnits - actualUnits : 0n;
  const expectedOverage = actualUnits > reservedUnits ? actualUnits - reservedUnits : 0n;
  if (decimalUnits(released) !== expectedReleased || decimalUnits(overage) !== expectedOverage) {
    reject();
  }
  return {
    schema_version: schemaVersion(input['schema_version']),
    state: literal(input['state'], 'committed'),
    reservation_id: uuid(input['reservation_id']),
    operation_id: uuid(input['operation_id']),
    reserved_usd: reserved,
    actual_usd: actual,
    released_usd: released,
    overage_usd: overage,
    budget_exceeded_after_commit: boolean(input['budget_exceeded_after_commit']),
    committed_at: timestamp(input['committed_at']),
    idempotent_replay: boolean(input['idempotent_replay']),
    late: boolean(input['late']),
  };
}

function parseReleaseRequestInternal(value: unknown): ReleaseUsageRequest {
  const input = record(value, ['schema_version', 'reason']);
  return {
    schema_version: schemaVersion(input['schema_version']),
    reason: oneOf(input['reason'], [
      'provider_not_called',
      'provider_confirmed_uncharged',
    ] as const),
  };
}

function parseReleaseResponseInternal(value: unknown): ReleaseUsageResponse {
  const input = record(value);
  return {
    schema_version: schemaVersion(input['schema_version']),
    state: literal(input['state'], 'released'),
    reservation_id: uuid(input['reservation_id']),
    operation_id: uuid(input['operation_id']),
    released_usd: canonicalDecimal(input['released_usd']),
    released_at: timestamp(input['released_at']),
    idempotent_replay: boolean(input['idempotent_replay']),
  };
}

function parseExtendRequestInternal(value: unknown): ExtendUsageRequest {
  const input = record(value, ['schema_version', 'extension_id', 'extend_by_seconds']);
  return {
    schema_version: schemaVersion(input['schema_version']),
    extension_id: uuid(input['extension_id']),
    extend_by_seconds: ttl(input['extend_by_seconds']),
  };
}

function parseExtendResponseInternal(value: unknown): ExtendUsageResponse {
  const input = record(value);
  return {
    schema_version: schemaVersion(input['schema_version']),
    state: literal(input['state'], 'reserved'),
    reservation_id: uuid(input['reservation_id']),
    operation_id: uuid(input['operation_id']),
    extension_id: uuid(input['extension_id']),
    expires_at: timestamp(input['expires_at']),
    idempotent_replay: boolean(input['idempotent_replay']),
  };
}

function parseCapabilitiesInternal(value: unknown): BudgetControlCapabilitiesResponse {
  const input = record(value);
  return {
    schema_version: schemaVersion(input['schema_version']),
    control_enabled: boolean(input['control_enabled']),
    min_reservation_ttl_seconds: literal(input['min_reservation_ttl_seconds'], 30),
    default_reservation_ttl_seconds: literal(input['default_reservation_ttl_seconds'], 300),
    max_reservation_ttl_seconds: literal(input['max_reservation_ttl_seconds'], 3_600),
    server_time: timestamp(input['server_time']),
  };
}

function parseErrorInternal(value: unknown): BudgetControlErrorResponse {
  const input = record(value);
  const error = record(input['error']);
  const parsed = {
    type: oneOf(error['type'], [
      'invalid_request_error',
      'authentication_error',
      'rate_limit_error',
      'api_error',
    ] as const),
    code: oneOf(error['code'], [
      'INVALID_API_KEY',
      'WRONG_SCOPE',
      'VALIDATION_ERROR',
      'RESOURCE_NOT_FOUND',
      'RATE_LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
      'IDEMPOTENCY_CONFLICT',
      'RESERVATION_STATE_CONFLICT',
    ] as const),
    message: string(error['message']),
  };
  return {
    error:
      error['param'] === undefined
        ? parsed
        : {
            ...parsed,
            param: string(error['param']),
          },
  };
}

function normalizeExactDecimalInput(value: unknown): unknown {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? String(Object.is(value, -0) ? 0 : value)
    : value;
}

const RESERVE_COMMON_FACADE_KEYS = [
  'kind',
  'operationId',
  'customerId',
  'traceId',
  'spanId',
  'parentSpanId',
  'stepName',
  'framework',
  'reservationTtlSeconds',
] as const;

export function buildReserveWire(
  value: unknown,
  mode: 'shadow' | 'enforce',
): ParsedReserveUsageRequest | null {
  return attempt(() => {
    const input = record(value);
    const kind = oneOf(input['kind'], ['llm', 'tool'] as const);
    exactKeys(
      input,
      kind === 'llm'
        ? [
            ...RESERVE_COMMON_FACADE_KEYS,
            'provider',
            'model',
            'estimatedInputTokens',
            'maxOutputTokens',
          ]
        : [...RESERVE_COMMON_FACADE_KEYS, 'costSourceSlug', 'toolName', 'metric', 'maximumValue'],
    );
    const common = {
      schema_version: SCHEMA_VERSION,
      mode,
      operation_id: input['operationId'],
      customer_id: input['customerId'],
      trace_id: input['traceId'],
      span_id: input['spanId'],
      parent_span_id: input['parentSpanId'],
      step_name: input['stepName'] ?? null,
      framework: input['framework'],
      reservation_ttl_seconds: input['reservationTtlSeconds'],
    };
    return parseReserveRequestInternal(
      kind === 'llm'
        ? {
            ...common,
            kind,
            provider: input['provider'],
            model: input['model'],
            estimated_input_tokens: input['estimatedInputTokens'],
            max_output_tokens: input['maxOutputTokens'],
          }
        : {
            ...common,
            kind,
            cost_source_slug: input['costSourceSlug'],
            tool_name: input['toolName'],
            metric: input['metric'],
            maximum_value: normalizeExactDecimalInput(input['maximumValue']),
          },
    );
  });
}

export interface BuiltCommitWire {
  reservationId: string;
  body: ParsedCommitUsageRequest;
}

export function buildCommitWire(value: unknown): BuiltCommitWire | null {
  return attempt(() => {
    const input = record(value);
    const kind = oneOf(input['kind'], ['llm', 'tool'] as const);
    exactKeys(
      input,
      kind === 'llm'
        ? [
            'reservationId',
            'kind',
            'status',
            'latencyMs',
            'streamAborted',
            'actualInputTokens',
            'actualOutputTokens',
          ]
        : ['reservationId', 'kind', 'status', 'latencyMs', 'streamAborted', 'actualValue'],
    );
    const common = {
      schema_version: SCHEMA_VERSION,
      status: input['status'],
      latency_ms: input['latencyMs'],
      stream_aborted: input['streamAborted'],
    };
    return {
      reservationId: uuid(input['reservationId']),
      body: parseCommitRequestInternal(
        kind === 'llm'
          ? {
              ...common,
              kind,
              actual_input_tokens: input['actualInputTokens'],
              actual_output_tokens: input['actualOutputTokens'],
            }
          : {
              ...common,
              kind,
              actual_value: normalizeExactDecimalInput(input['actualValue']),
            },
      ),
    };
  });
}

export interface BuiltReleaseWire {
  reservationId: string;
  body: ReleaseUsageRequest;
}

export function buildReleaseWire(value: unknown): BuiltReleaseWire | null {
  return attempt(() => {
    const input = record(value, ['reservationId', 'reason']);
    return {
      reservationId: uuid(input['reservationId']),
      body: parseReleaseRequestInternal({
        schema_version: SCHEMA_VERSION,
        reason: input['reason'],
      }),
    };
  });
}

export interface BuiltExtendWire {
  reservationId: string;
  body: ExtendUsageRequest;
}

export function buildExtendWire(value: unknown): BuiltExtendWire | null {
  return attempt(() => {
    const input = record(value, ['reservationId', 'extensionId', 'extendBySeconds']);
    return {
      reservationId: uuid(input['reservationId']),
      body: parseExtendRequestInternal({
        schema_version: SCHEMA_VERSION,
        extension_id: input['extensionId'],
        extend_by_seconds: input['extendBySeconds'],
      }),
    };
  });
}

export const parseControlCapabilities = (value: unknown) =>
  attempt(() => parseCapabilitiesInternal(value));
export const parseReserveWire = (value: unknown) =>
  attempt(() => parseReserveRequestInternal(value));
export const parseReserveResponse = (value: unknown) =>
  attempt(() => parseReserveResponseInternal(value));
export const parseCommitWire = (value: unknown) => attempt(() => parseCommitRequestInternal(value));
export const parseCommitResponse = (value: unknown) =>
  attempt(() => parseCommitResponseInternal(value));
export const parseReleaseWire = (value: unknown) =>
  attempt(() => parseReleaseRequestInternal(value));
export const parseReleaseResponse = (value: unknown) =>
  attempt(() => parseReleaseResponseInternal(value));
export const parseExtendWire = (value: unknown) => attempt(() => parseExtendRequestInternal(value));
export const parseExtendResponse = (value: unknown) =>
  attempt(() => parseExtendResponseInternal(value));
export const parseControlError = (value: unknown) => attempt(() => parseErrorInternal(value));
