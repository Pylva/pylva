// Canonical authoritative control for one strictly validated LLM attempt.
//
// Provider entrypoints share this private runtime so capability coalescing,
// receipt ownership, authenticated transport, and error identities remain
// canonical across deep imports. Unlike the public all-cost facade, request
// values here have already been detached by a strict adapter and response
// values come directly from JSON.parse. We therefore validate every wire
// invariant without carrying the generic descriptor/proxy facade.

import { BudgetExceededSource, PylvaBudgetExceeded } from '../errors/budget_exceeded.js';
import {
  PylvaControlApiError,
  PylvaControlUnavailableError,
  PylvaControlUnavailableReason,
  PylvaControlValidationError,
  type PylvaControlUnavailableReason as ControlUnavailableReason,
} from '../errors/control.js';
import {
  AuthenticatedRoute,
  ControlMode,
  ControlUnavailablePolicy,
  coreRuntime,
  getConfigGeneration,
  requireConfig,
  type AuthenticatedResponseSnapshot,
  type RuntimeConfig,
} from '../internal/core-runtime-state.js';
import { registerIdentityResetter } from './identity_registry.js';
import type {
  BypassedUsageResult,
  CommitUsageResult,
  ControlCapabilities,
  ReleaseUsageResult,
  ReserveUsageResult,
  ReservedUsageResult,
  UnavailableUsageResult,
} from './control_client.js';
import type {
  AuthoritativeBudgetDenial,
  AuthoritativeBudgetRuleSnapshot,
  AuthoritativeBudgetWarning,
} from '../errors/budget_exceeded.js';

const VERSION = '1.0' as const;
const CAPABILITY_TTL_MS = 30_000;
const UINT32_MAX = 4_294_967_295;
const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu;
const TIMESTAMP =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:[12]\d|0[1-9]|3[01])T(?:0\d|1\d|2[0-3])(?::[0-5]\d){2}(?:\.\d{1,3})?Z$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/;
const WIDE_DECIMAL = /^(?:0|[1-9][0-9]{0,25})(?:\.[0-9]{1,18})?$/;
const BLANK =
  /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*$/u;
const INVALID_UNICODE = /[\uD800-\uDFFF]/u;
const CONTROL_CHARACTER = /[\u0000-\u001F\u007F]/;
const CUSTOMER_ID = /^[a-zA-Z0-9_-]+$/;
const STEP_NAME = /^[a-zA-Z0-9 _\-.:/]*$/;
const SCALE = 18;
const FACTOR = 10n ** BigInt(SCALE);
const INVALID = Symbol('invalid-strict-control-wire');

type JsonObject = Record<string, unknown>;
export type StrictCapability =
  | { kind: 'supported'; value: ControlCapabilities }
  | { kind: 'unsupported' };

export interface StrictControlContext {
  readonly config: RuntimeConfig;
  readonly requestEpoch: number;
  readonly generation: number;
}

interface CapabilityCache {
  epoch: number;
  generation: number;
  expiresAt: number;
  value: StrictCapability;
}

interface CapabilityFlight {
  epoch: number;
  generation: number;
  promise: Promise<StrictCapability>;
}

interface ReceiptOwner {
  generation: number;
  operationId: string;
  reservationId: string;
}

export interface StrictLlmReserveInput {
  operationId: string;
  customerId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  stepName: string | null;
  framework: string;
  reservationTtlSeconds?: number;
  provider: string;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface StrictLlmCommitInput {
  reservationId: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  latencyMs: number;
  status: string;
  streamAborted: boolean;
}

export interface StrictExtendResult {
  schemaVersion: '1.0';
  state: 'reserved';
  reservationId: string;
  operationId: string;
  extensionId: string;
  expiresAt: string;
  idempotentReplay: boolean;
}

export class StrictTransportUnavailable extends Error {
  constructor(
    readonly reason: ControlUnavailableReason,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super('strict control transport unavailable');
  }
}

let epoch = 0;
let capabilityCache: CapabilityCache | null = null;
let capabilityFlight: CapabilityFlight | null = null;
const receiptOwners = new WeakMap<object, ReceiptOwner>();

function reject(): never {
  throw INVALID;
}

function attempt<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function validated<T>(operation: string, read: () => T): T {
  const value = attempt(read);
  if (value === null) throw new PylvaControlValidationError(operation);
  return value;
}

// Only values returned by JSON.parse reach these readers. JSON cannot create
// proxies, accessors, symbols, holes, custom prototypes, or non-enumerable
// fields. Semantic and cross-field validation remains exhaustive below.
function object(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) reject();
  return value as JsonObject;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) reject();
  return value;
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

function oneOf<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== 'string' || !values.includes(value)) reject();
  return value as T[number];
}

function uuid(value: unknown): string {
  const parsed = string(value);
  if (!UUID.test(parsed)) reject();
  return parsed.toLowerCase();
}

function nullableUuid(value: unknown): string | null {
  return value === null ? null : uuid(value);
}

function timestamp(value: unknown): string {
  const parsed = string(value);
  if (!TIMESTAMP.test(parsed)) reject();
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(parsed);
  if (parts === null) reject();
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    year === 0 ||
    !Number.isFinite(Date.parse(parsed)) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    reject();
  }
  return parsed;
}

function uint32(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > UINT32_MAX
  ) {
    reject();
  }
  return Object.is(value, -0) ? 0 : value;
}

function ttl(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 30 || value > 3_600) {
    reject();
  }
  return value;
}

function decimal(value: unknown, wide = false): string {
  const parsed = string(value);
  if (!(wide ? WIDE_DECIMAL : DECIMAL).test(parsed)) reject();
  return parsed.includes('.') ? parsed.replace(/0+$/, '').replace(/\.$/, '') : parsed;
}

function units(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * FACTOR + BigInt(fraction.padEnd(SCALE, '0'));
}

function storeSafe(value: unknown, maximum: number): string {
  const parsed = string(value);
  if (
    [...parsed].length > maximum ||
    BLANK.test(parsed) ||
    INVALID_UNICODE.test(parsed) ||
    CONTROL_CHARACTER.test(parsed)
  ) {
    reject();
  }
  return parsed;
}

function customerId(value: unknown): string {
  const parsed = string(value);
  if (parsed.length < 1 || parsed.length > 255 || !CUSTOMER_ID.test(parsed)) reject();
  return parsed;
}

function stepName(value: unknown): string | null {
  if (value === null) return null;
  const parsed = string(value);
  if (parsed.length > 200 || !STEP_NAME.test(parsed)) reject();
  return parsed;
}

function parseWarning(value: unknown): AuthoritativeBudgetWarning {
  const input = object(value);
  const limitUsd = decimal(input['limit_usd']);
  const projectedUsd = decimal(input['projected_usd']);
  if (units(projectedUsd) <= units(limitUsd)) reject();
  return {
    code: literal(input['code'], 'advisory_budget_exceeded'),
    ruleId: uuid(input['rule_id']),
    limitUsd,
    projectedUsd,
  };
}

function parseWarnings(value: unknown): AuthoritativeBudgetWarning[] {
  return array(value).map(parseWarning);
}

function parseRule(value: unknown): AuthoritativeBudgetRuleSnapshot {
  const input = object(value);
  const scope = oneOf(input['scope'], ['per_customer', 'pooled'] as const);
  const periodStart = timestamp(input['period_start']);
  const periodEnd = timestamp(input['period_end']);
  if (Date.parse(periodEnd) <= Date.parse(periodStart)) reject();
  return {
    ruleId: uuid(input['rule_id']),
    scope,
    customerId:
      scope === 'per_customer'
        ? customerId(input['customer_id'])
        : literal(input['customer_id'], null),
    period: oneOf(input['period'], ['hour', 'day', 'week', 'month'] as const),
    periodStart,
    periodEnd,
  };
}

export function parseStrictReserveResponse(
  value: unknown,
): ReserveUsageResult | AuthoritativeBudgetDenial | null {
  return attempt(() => {
    const input = object(value);
    const decision = oneOf(input['decision'], [
      'reserved',
      'denied',
      'bypassed',
      'unavailable',
    ] as const);
    const schemaVersion = literal(input['schema_version'], VERSION);
    const operationId = uuid(input['operation_id']);
    if (decision === 'reserved') {
      return {
        schemaVersion,
        decision,
        allowed: literal(input['allowed'], true),
        decisionId: uuid(input['decision_id']),
        operationId,
        reservationId: uuid(input['reservation_id']),
        state: literal(input['state'], 'reserved'),
        reservedUsd: decimal(input['reserved_usd']),
        remainingUsd: input['remaining_usd'] === null ? null : decimal(input['remaining_usd']),
        expiresAt: timestamp(input['expires_at']),
        warnings: parseWarnings(input['warnings']),
      } satisfies ReservedUsageResult;
    }
    if (decision === 'denied') {
      const committedUsd = decimal(input['committed_usd']);
      const reservedUsd = decimal(input['reserved_usd']);
      const unresolvedUsd = decimal(input['unresolved_usd']);
      const requestedUsd = decimal(input['requested_usd']);
      const limitUsd = decimal(input['limit_usd']);
      const remainingUsd = decimal(input['remaining_usd']);
      const protectedBefore = units(committedUsd) + units(reservedUsd) + units(unresolvedUsd);
      const limit = units(limitUsd);
      const expectedRemaining = limit > protectedBefore ? limit - protectedBefore : 0n;
      if (
        protectedBefore + units(requestedUsd) <= limit ||
        units(remainingUsd) !== expectedRemaining
      ) {
        reject();
      }
      return {
        schemaVersion,
        decision,
        allowed: literal(input['allowed'], false),
        decisionId: uuid(input['decision_id']),
        operationId,
        state: literal(input['state'], 'refused'),
        decidingRule: parseRule(input['deciding_rule']),
        committedUsd,
        reservedUsd,
        unresolvedUsd,
        requestedUsd,
        limitUsd,
        remainingUsd,
        warnings: parseWarnings(input['warnings']),
      } satisfies AuthoritativeBudgetDenial;
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
        schemaVersion,
        decision,
        allowed: literal(input['allowed'], true),
        decisionId,
        operationId,
        reason,
        wouldHaveDenied,
        warnings,
        local: false,
      } satisfies BypassedUsageResult;
    }
    return {
      schemaVersion,
      decision,
      allowed: literal(input['allowed'], false),
      decisionId: nullableUuid(input['decision_id']),
      operationId,
      reason: oneOf(input['reason'], [
        'pricing_unavailable',
        'usage_bound_required',
        'control_unavailable',
      ] as const),
      retryable: boolean(input['retryable']),
      controlReason: oneOf(input['reason'], [
        'pricing_unavailable',
        'usage_bound_required',
        'control_unavailable',
      ] as const),
      local: false,
    } satisfies UnavailableUsageResult;
  });
}

export function parseStrictCapabilities(value: unknown): ControlCapabilities | null {
  return attempt(() => {
    const input = object(value);
    return {
      schemaVersion: literal(input['schema_version'], VERSION),
      controlEnabled: boolean(input['control_enabled']),
      minReservationTtlSeconds: literal(input['min_reservation_ttl_seconds'], 30),
      defaultReservationTtlSeconds: literal(input['default_reservation_ttl_seconds'], 300),
      maxReservationTtlSeconds: literal(input['max_reservation_ttl_seconds'], 3_600),
      serverTime: timestamp(input['server_time']),
    };
  });
}

export function parseStrictCommitResponse(value: unknown): CommitUsageResult | null {
  return attempt(() => {
    const input = object(value);
    const reservedUsd = decimal(input['reserved_usd']);
    const actualUsd = decimal(input['actual_usd'], true);
    const releasedUsd = decimal(input['released_usd']);
    const overageUsd = decimal(input['overage_usd'], true);
    const reserved = units(reservedUsd);
    const actual = units(actualUsd);
    if (
      units(releasedUsd) !== (reserved > actual ? reserved - actual : 0n) ||
      units(overageUsd) !== (actual > reserved ? actual - reserved : 0n)
    ) {
      reject();
    }
    return {
      schemaVersion: literal(input['schema_version'], VERSION),
      state: literal(input['state'], 'committed'),
      reservationId: uuid(input['reservation_id']),
      operationId: uuid(input['operation_id']),
      reservedUsd,
      actualUsd,
      releasedUsd,
      overageUsd,
      budgetExceededAfterCommit: boolean(input['budget_exceeded_after_commit']),
      committedAt: timestamp(input['committed_at']),
      idempotentReplay: boolean(input['idempotent_replay']),
      late: boolean(input['late']),
    };
  });
}

export function parseStrictReleaseResponse(value: unknown): ReleaseUsageResult | null {
  return attempt(() => {
    const input = object(value);
    return {
      schemaVersion: literal(input['schema_version'], VERSION),
      state: literal(input['state'], 'released'),
      reservationId: uuid(input['reservation_id']),
      operationId: uuid(input['operation_id']),
      releasedUsd: decimal(input['released_usd']),
      releasedAt: timestamp(input['released_at']),
      idempotentReplay: boolean(input['idempotent_replay']),
    };
  });
}

export function parseStrictExtendResponse(value: unknown): StrictExtendResult | null {
  return attempt(() => {
    const input = object(value);
    return {
      schemaVersion: literal(input['schema_version'], VERSION),
      state: literal(input['state'], 'reserved'),
      reservationId: uuid(input['reservation_id']),
      operationId: uuid(input['operation_id']),
      extensionId: uuid(input['extension_id']),
      expiresAt: timestamp(input['expires_at']),
      idempotentReplay: boolean(input['idempotent_replay']),
    };
  });
}

export function parseStrictError(value: unknown): { code: string } | null {
  return attempt(() => {
    const error = object(object(value)['error']);
    oneOf(error['type'], [
      'invalid_request_error',
      'authentication_error',
      'rate_limit_error',
      'api_error',
    ] as const);
    const code = oneOf(error['code'], [
      'INVALID_API_KEY',
      'WRONG_SCOPE',
      'VALIDATION_ERROR',
      'RESOURCE_NOT_FOUND',
      'RATE_LIMIT_EXCEEDED',
      'INTERNAL_ERROR',
      'IDEMPOTENCY_CONFLICT',
      'RESERVATION_STATE_CONFLICT',
    ] as const);
    string(error['message']);
    if (error['param'] !== undefined) string(error['param']);
    return { code };
  });
}

/** Source-test hook; absent from every published entrypoint and tree-shaken. */
export function _parseStrictResponseForTests(
  schema:
    | 'capabilities_response'
    | 'reservation_response'
    | 'commit_response'
    | 'release_response'
    | 'extend_response'
    | 'error_response',
  value: unknown,
): unknown | null {
  switch (schema) {
    case 'capabilities_response':
      return parseStrictCapabilities(value);
    case 'reservation_response':
      return parseStrictReserveResponse(value);
    case 'commit_response':
      return parseStrictCommitResponse(value);
    case 'release_response':
      return parseStrictReleaseResponse(value);
    case 'extend_response':
      return parseStrictExtendResponse(value);
    case 'error_response':
      return parseStrictError(value);
  }
}

function errorStatusMatches(status: number, code: string): boolean {
  return (
    (status === 400 && code === 'VALIDATION_ERROR') ||
    (status === 401 && code === 'INVALID_API_KEY') ||
    (status === 403 && code === 'WRONG_SCOPE') ||
    (status === 404 && code === 'RESOURCE_NOT_FOUND') ||
    (status === 409 &&
      (code === 'IDEMPOTENCY_CONFLICT' || code === 'RESERVATION_STATE_CONFLICT')) ||
    (status === 429 && code === 'RATE_LIMIT_EXCEEDED') ||
    (status >= 500 && status <= 599 && code === 'INTERNAL_ERROR')
  );
}

function assertIdentity(requestEpoch: number, generation: number): void {
  if (requestEpoch !== epoch || generation !== getConfigGeneration()) {
    throw new StrictTransportUnavailable(PylvaControlUnavailableReason.CONFIGURATION_CHANGED, true);
  }
}

async function request<T>(input: {
  config: RuntimeConfig;
  requestEpoch: number;
  generation: number;
  route:
    | typeof AuthenticatedRoute.CONTROL_CAPABILITIES
    | typeof AuthenticatedRoute.CONTROL_RESERVE
    | typeof AuthenticatedRoute.CONTROL_COMMIT
    | typeof AuthenticatedRoute.CONTROL_RELEASE
    | typeof AuthenticatedRoute.CONTROL_EXTEND;
  reservationId?: string;
  body?: unknown;
  parse: (value: unknown) => T | null;
  oldBackendFallback?: boolean;
}): Promise<T | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StrictTransportUnavailable(PylvaControlUnavailableReason.TIMEOUT, true));
    }, input.config.control.timeoutMs);
    timer.unref?.();
  });
  let response: AuthenticatedResponseSnapshot;
  try {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const pending =
      input.route === AuthenticatedRoute.CONTROL_CAPABILITIES
        ? coreRuntime.authenticatedRequest({ route: input.route, signal: controller.signal })
        : input.route === AuthenticatedRoute.CONTROL_RESERVE
          ? coreRuntime.authenticatedRequest({
              route: input.route,
              body: body!,
              signal: controller.signal,
            })
          : coreRuntime.authenticatedRequest({
              route: input.route,
              reservationId: input.reservationId!,
              body: body!,
              signal: controller.signal,
            });
    response = await Promise.race([pending, deadline]);
  } catch {
    if (input.requestEpoch !== epoch || input.generation !== getConfigGeneration()) {
      throw new StrictTransportUnavailable(
        PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
        true,
      );
    }
    if (controller.signal.aborted) {
      throw new StrictTransportUnavailable(PylvaControlUnavailableReason.TIMEOUT, true);
    }
    throw new StrictTransportUnavailable(PylvaControlUnavailableReason.NETWORK_ERROR, true);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  assertIdentity(input.requestEpoch, input.generation);
  if (input.oldBackendFallback && (response.status === 404 || response.status === 405)) return null;
  let json: unknown;
  try {
    json = JSON.parse(response.bodyText) as unknown;
  } catch {
    throw new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false);
  }
  assertIdentity(input.requestEpoch, input.generation);
  if (response.ok) {
    const parsed = input.parse(json);
    if (parsed === null) {
      throw new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false);
    }
    return parsed;
  }
  const error = parseStrictError(json);
  if (error === null || !errorStatusMatches(response.status, error.code)) {
    throw new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false);
  }
  if (response.status === 429) {
    throw new StrictTransportUnavailable(PylvaControlUnavailableReason.RATE_LIMITED, true, 429);
  }
  if (response.status >= 500) {
    throw new StrictTransportUnavailable(
      PylvaControlUnavailableReason.SERVICE_UNAVAILABLE,
      true,
      response.status,
    );
  }
  throw new PylvaControlApiError(response.status, error.code, null);
}

async function capabilities(
  config: RuntimeConfig,
  requestEpoch: number,
  generation: number,
): Promise<StrictCapability> {
  const now = Date.now();
  if (
    capabilityCache?.epoch === requestEpoch &&
    capabilityCache.generation === generation &&
    capabilityCache.expiresAt > now
  ) {
    return capabilityCache.value;
  }
  if (capabilityFlight?.epoch === requestEpoch && capabilityFlight.generation === generation) {
    return capabilityFlight.promise;
  }
  const promise = request({
    config,
    requestEpoch,
    generation,
    route: AuthenticatedRoute.CONTROL_CAPABILITIES,
    parse: parseStrictCapabilities,
    oldBackendFallback: true,
  }).then(
    (value): StrictCapability =>
      value === null ? { kind: 'unsupported' } : { kind: 'supported', value },
  );
  capabilityFlight = { epoch: requestEpoch, generation, promise };
  try {
    const value = await promise;
    assertIdentity(requestEpoch, generation);
    capabilityCache = {
      epoch: requestEpoch,
      generation,
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
      value,
    };
    return value;
  } finally {
    if (capabilityFlight?.promise === promise) capabilityFlight = null;
  }
}

export function createStrictControlContext(
  config: RuntimeConfig = requireConfig(),
): StrictControlContext {
  return { config, requestEpoch: epoch, generation: getConfigGeneration() };
}

export function getStrictCapabilities(context: StrictControlContext): Promise<StrictCapability> {
  return capabilities(context.config, context.requestEpoch, context.generation);
}

export function strictJsonRequest<T>(
  context: StrictControlContext,
  input: {
    route:
      | typeof AuthenticatedRoute.CONTROL_RESERVE
      | typeof AuthenticatedRoute.CONTROL_COMMIT
      | typeof AuthenticatedRoute.CONTROL_RELEASE
      | typeof AuthenticatedRoute.CONTROL_EXTEND;
    reservationId?: string;
    body: unknown;
    parse: (value: unknown) => T | null;
  },
): Promise<T | null> {
  return request({
    ...context,
    route: input.route,
    reservationId: input.reservationId,
    body: input.body,
    parse: input.parse,
  });
}

function buildReserve(input: StrictLlmReserveInput, mode: 'shadow' | 'enforce') {
  return {
    schema_version: VERSION,
    mode,
    operation_id: uuid(input.operationId),
    customer_id: customerId(input.customerId),
    trace_id: uuid(input.traceId),
    span_id: uuid(input.spanId),
    parent_span_id: input.parentSpanId === null ? null : uuid(input.parentSpanId),
    step_name: stepName(input.stepName),
    framework: oneOf(input.framework, [
      'langgraph',
      'crewai',
      'mastra',
      'openai-agents',
      'pydantic-ai',
      'none',
    ] as const),
    reservation_ttl_seconds:
      input.reservationTtlSeconds === undefined ? 300 : ttl(input.reservationTtlSeconds),
    kind: 'llm' as const,
    provider: storeSafe(input.provider, 255),
    model: storeSafe(input.model, 255),
    estimated_input_tokens: uint32(input.estimatedInputTokens),
    max_output_tokens: uint32(input.maxOutputTokens),
  };
}

function unavailable(
  operationId: string,
  reason: ControlUnavailableReason,
  retryable: boolean,
): UnavailableUsageResult {
  return {
    schemaVersion: VERSION,
    decision: 'unavailable',
    allowed: false,
    decisionId: null,
    operationId,
    reason: 'control_unavailable',
    retryable,
    controlReason: reason,
    local: true,
  };
}

function applyUnavailablePolicy(
  config: RuntimeConfig,
  value: UnavailableUsageResult,
  status: number | null = null,
): UnavailableUsageResult {
  if (config.control.onUnavailable === ControlUnavailablePolicy.DENY) {
    throw new PylvaControlUnavailableError({
      reason: value.controlReason,
      retryable: value.retryable,
      operation: 'reserveUsage',
      operationId: value.operationId,
      unavailableResponse: {
        schemaVersion: value.schemaVersion,
        decision: value.decision,
        allowed: value.allowed,
        decisionId: value.decisionId,
        operationId: value.operationId,
        reason: value.reason,
        retryable: value.retryable,
      },
      status,
    });
  }
  return value;
}

function exactSum(values: string[]): string {
  const total = values.reduce((sum, value) => sum + units(value), 0n);
  const fraction = (total % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return fraction.length === 0 ? String(total / FACTOR) : `${total / FACTOR}.${fraction}`;
}

function throwDenied(value: AuthoritativeBudgetDenial, attemptedCustomerId: string): never {
  throw new PylvaBudgetExceeded({
    source: BudgetExceededSource.AUTHORITATIVE_CONTROL,
    rule_id: value.decidingRule.ruleId,
    customer_id: attemptedCustomerId,
    period: value.decidingRule.period,
    period_start: value.decidingRule.periodStart,
    limit_usd: Number(value.limitUsd),
    accumulated_usd: Number(exactSum([value.committedUsd, value.reservedUsd, value.unresolvedUsd])),
    estimated_usd: Number(value.requestedUsd),
    authoritativeDenial: value,
  });
}

export async function strictReserveLlm(input: StrictLlmReserveInput): Promise<ReserveUsageResult> {
  const config = requireConfig();
  const mode = config.control.mode;
  const body = validated('reserveUsage', () =>
    buildReserve(input, mode === ControlMode.SHADOW ? 'shadow' : 'enforce'),
  );
  if (mode === ControlMode.LEGACY) {
    return {
      schemaVersion: VERSION,
      decision: 'bypassed',
      allowed: true,
      decisionId: null,
      operationId: body.operation_id,
      reason: 'control_disabled',
      wouldHaveDenied: null,
      warnings: [],
      local: true,
    };
  }
  const requestEpoch = epoch;
  const generation = getConfigGeneration();
  let available: StrictCapability;
  try {
    available = await capabilities(config, requestEpoch, generation);
  } catch (error) {
    if (!(error instanceof StrictTransportUnavailable)) throw error;
    return applyUnavailablePolicy(
      config,
      unavailable(body.operation_id, error.reason, error.retryable),
      error.status,
    );
  }
  if (available.kind === 'unsupported' || !available.value.controlEnabled) {
    const reason =
      available.kind === 'unsupported'
        ? PylvaControlUnavailableReason.UNSUPPORTED_BACKEND
        : PylvaControlUnavailableReason.CONTROL_DISABLED;
    return applyUnavailablePolicy(config, unavailable(body.operation_id, reason, false));
  }
  let response: ReserveUsageResult | AuthoritativeBudgetDenial;
  try {
    response = (await request({
      config,
      requestEpoch,
      generation,
      route: AuthenticatedRoute.CONTROL_RESERVE,
      body,
      parse: parseStrictReserveResponse,
    }))!;
  } catch (error) {
    if (!(error instanceof StrictTransportUnavailable)) throw error;
    return applyUnavailablePolicy(
      config,
      unavailable(body.operation_id, error.reason, error.retryable),
      error.status,
    );
  }
  if (response.operationId !== body.operation_id) {
    return applyUnavailablePolicy(
      config,
      unavailable(body.operation_id, PylvaControlUnavailableReason.INVALID_RESPONSE, false),
    );
  }
  const modeMatches =
    mode === ControlMode.SHADOW
      ? response.decision === 'bypassed'
      : response.decision !== 'bypassed' ||
        response.reason === 'no_applicable_budget' ||
        response.reason === 'control_disabled';
  if (!modeMatches) {
    return applyUnavailablePolicy(
      config,
      unavailable(body.operation_id, PylvaControlUnavailableReason.INVALID_RESPONSE, false),
    );
  }
  if (
    response.decision === 'bypassed' &&
    (response.reason === 'control_disabled' || response.reason === 'shadow_control_unavailable')
  ) {
    return applyUnavailablePolicy(
      config,
      unavailable(
        body.operation_id,
        response.reason === 'control_disabled'
          ? PylvaControlUnavailableReason.CONTROL_DISABLED
          : PylvaControlUnavailableReason.CONTROL_UNAVAILABLE,
        response.reason === 'shadow_control_unavailable',
      ),
    );
  }
  if (response.decision === 'unavailable') {
    return applyUnavailablePolicy(config, response);
  }
  if (response.decision === 'denied') throwDenied(response, body.customer_id);
  if (response.decision === 'reserved') {
    receiptOwners.set(response, {
      generation,
      operationId: response.operationId,
      reservationId: response.reservationId,
    });
  }
  return response;
}

export function ownsStrictReservation(
  value: unknown,
  operationId: string,
  reservationId: string,
): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const owner = receiptOwners.get(value);
  const receipt = value as Partial<ReservedUsageResult>;
  return (
    owner?.generation === getConfigGeneration() &&
    owner.operationId === operationId &&
    owner.reservationId === reservationId &&
    receipt.decision === 'reserved' &&
    receipt.operationId === operationId &&
    receipt.reservationId === reservationId
  );
}

function lifecycleUnavailable(
  error: StrictTransportUnavailable,
  operation: 'commitUsage' | 'releaseUsage' | 'extendUsage',
  reservationId: string,
): never {
  throw new PylvaControlUnavailableError({
    reason: error.reason,
    retryable: error.retryable,
    operation,
    reservationId,
    status: error.status,
  });
}

async function lifecycle<T>(input: {
  operation: 'commitUsage' | 'releaseUsage' | 'extendUsage';
  route:
    | typeof AuthenticatedRoute.CONTROL_COMMIT
    | typeof AuthenticatedRoute.CONTROL_RELEASE
    | typeof AuthenticatedRoute.CONTROL_EXTEND;
  reservationId: string;
  body: unknown;
  parse: (value: unknown) => T | null;
}): Promise<T> {
  const config = requireConfig();
  const requestEpoch = epoch;
  const generation = getConfigGeneration();
  try {
    return (await request({
      config,
      requestEpoch,
      generation,
      route: input.route,
      reservationId: input.reservationId,
      body: input.body,
      parse: input.parse,
    }))!;
  } catch (error) {
    if (error instanceof StrictTransportUnavailable) {
      lifecycleUnavailable(error, input.operation, input.reservationId);
    }
    throw error;
  }
}

export async function strictCommitLlm(input: StrictLlmCommitInput): Promise<CommitUsageResult> {
  const reservationId = validated('commitUsage', () => uuid(input.reservationId));
  const body = validated('commitUsage', () => ({
    schema_version: VERSION,
    status: oneOf(input.status, ['success', 'failure', 'retry', 'aborted'] as const),
    latency_ms: uint32(input.latencyMs),
    stream_aborted: boolean(input.streamAborted),
    kind: 'llm' as const,
    actual_input_tokens: uint32(input.actualInputTokens),
    actual_output_tokens: uint32(input.actualOutputTokens),
  }));
  const value = await lifecycle({
    operation: 'commitUsage',
    route: AuthenticatedRoute.CONTROL_COMMIT,
    reservationId,
    body,
    parse: parseStrictCommitResponse,
  });
  if (value.reservationId !== reservationId) {
    lifecycleUnavailable(
      new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false),
      'commitUsage',
      reservationId,
    );
  }
  return value;
}

export async function strictRelease(
  rawReservationId: string,
  reason: 'provider_not_called' | 'provider_confirmed_uncharged',
): Promise<ReleaseUsageResult> {
  const reservationId = validated('releaseUsage', () => uuid(rawReservationId));
  const body = validated('releaseUsage', () => ({
    schema_version: VERSION,
    reason: oneOf(reason, ['provider_not_called', 'provider_confirmed_uncharged'] as const),
  }));
  const value = await lifecycle({
    operation: 'releaseUsage',
    route: AuthenticatedRoute.CONTROL_RELEASE,
    reservationId,
    body,
    parse: parseStrictReleaseResponse,
  });
  if (value.reservationId !== reservationId) {
    lifecycleUnavailable(
      new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false),
      'releaseUsage',
      reservationId,
    );
  }
  return value;
}

export async function strictExtend(
  rawReservationId: string,
  rawExtensionId: string,
  rawExtendBySeconds: number,
): Promise<StrictExtendResult> {
  const request = validated('extendUsage', () => ({
    reservationId: uuid(rawReservationId),
    extensionId: uuid(rawExtensionId),
    extendBySeconds: ttl(rawExtendBySeconds),
  }));
  const { reservationId, extensionId } = request;
  const value = await lifecycle({
    operation: 'extendUsage',
    route: AuthenticatedRoute.CONTROL_EXTEND,
    reservationId,
    body: {
      schema_version: VERSION,
      extension_id: extensionId,
      extend_by_seconds: request.extendBySeconds,
    },
    parse: parseStrictExtendResponse,
  });
  if (value.reservationId !== reservationId || value.extensionId !== extensionId) {
    lifecycleUnavailable(
      new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false),
      'extendUsage',
      reservationId,
    );
  }
  return value;
}

function resetStrictControl(): void {
  epoch += 1;
  capabilityCache = null;
  capabilityFlight = null;
}

/** Source-test reset; absent from the published API and tree-shaken. */
export function _resetStrictControlForTests(): void {
  resetStrictControl();
}

registerIdentityResetter(resetStrictControl);
