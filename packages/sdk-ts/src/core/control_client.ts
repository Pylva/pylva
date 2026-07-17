// Authoritative budget-control client.
//
// Public values are camelCase. Every request is rebuilt as the strict v1.0
// snake_case wire contract, and every response is schema-validated before it
// reaches caller code. Prompt, completion, tool arguments, and message bodies
// are intentionally absent from this API.

import type { BudgetReleaseReason } from '@pylva/shared/budget-control';
import type { EventStatus, Framework } from '@pylva/shared/telemetry';
import {
  ControlMode,
  ControlUnavailablePolicy,
  getConfig,
  getConfigGeneration,
  requireConfig,
  type RuntimeConfig,
} from './config.js';
import { AuthenticatedRoute } from '../internal/core-runtime-state.js';
import {
  PylvaBudgetExceeded,
  BudgetExceededSource,
  type AuthoritativeBudgetDenial,
  type AuthoritativeBudgetRuleSnapshot,
  type AuthoritativeBudgetWarning,
} from '../errors/budget_exceeded.js';
import {
  PylvaControlUnavailableError,
  PylvaControlUnavailableReason,
  PylvaControlValidationError,
  type PylvaControlUnavailableReason as PylvaControlUnavailableReasonType,
  type PylvaUnavailableResponseEvidence,
} from '../errors/control.js';
import {
  buildCommitWire,
  buildExtendWire,
  buildReleaseWire,
  buildReserveWire,
} from './control_wire.js';
import {
  _resetStrictControlForTests,
  createStrictControlContext,
  getStrictCapabilities,
  parseStrictCommitResponse,
  parseStrictExtendResponse,
  parseStrictReleaseResponse,
  parseStrictReserveResponse,
  strictJsonRequest,
  StrictTransportUnavailable,
} from './strict_attempt_control.js';

const BUDGET_CONTROL_SCHEMA_VERSION = '1.0' as const;
const BudgetBypassReason = {
  CONTROL_DISABLED: 'control_disabled',
  NO_APPLICABLE_BUDGET: 'no_applicable_budget',
  SHADOW_WOULD_ALLOW: 'shadow_would_allow',
  SHADOW_WOULD_DENY: 'shadow_would_deny',
  SHADOW_CONTROL_UNAVAILABLE: 'shadow_control_unavailable',
} as const;
export type ExactDecimalInput = string | number;

export interface ReserveUsageCommonInput {
  operationId: string;
  customerId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  stepName?: string | null;
  framework?: Framework;
  reservationTtlSeconds?: number;
}

export interface LlmReserveUsageInput extends ReserveUsageCommonInput {
  kind: 'llm';
  provider: string;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
}

export interface ToolReserveUsageInput extends ReserveUsageCommonInput {
  kind: 'tool';
  costSourceSlug: string;
  toolName: string;
  metric: string;
  maximumValue: ExactDecimalInput;
}

export type ReserveUsageInput = LlmReserveUsageInput | ToolReserveUsageInput;

interface CommitUsageCommonInput {
  reservationId: string;
  status: EventStatus;
  latencyMs: number;
  streamAborted: boolean;
}

export interface LlmCommitUsageInput extends CommitUsageCommonInput {
  kind: 'llm';
  actualInputTokens: number;
  actualOutputTokens: number;
}

export interface ToolCommitUsageInput extends CommitUsageCommonInput {
  kind: 'tool';
  actualValue: ExactDecimalInput;
}

export type CommitUsageInput = LlmCommitUsageInput | ToolCommitUsageInput;

export interface ReleaseUsageInput {
  reservationId: string;
  reason: BudgetReleaseReason;
}

export interface ExtendUsageInput {
  reservationId: string;
  extensionId: string;
  extendBySeconds: number;
}

export interface ControlCapabilities {
  schemaVersion: '1.0';
  controlEnabled: boolean;
  minReservationTtlSeconds: 30;
  defaultReservationTtlSeconds: 300;
  maxReservationTtlSeconds: 3600;
  serverTime: string;
}

export interface ControlReadyResult {
  ready: boolean;
  supported: boolean | null;
  controlEnabled: boolean | null;
  mode: 'legacy' | 'shadow' | 'enforce';
  capabilities: ControlCapabilities | null;
  reason: PylvaControlUnavailableReasonType | null;
  retryable: boolean;
}

export interface BudgetControlWarning extends AuthoritativeBudgetWarning {}
export type BudgetControlRuleSnapshot = AuthoritativeBudgetRuleSnapshot;

export interface ReservedUsageResult {
  schemaVersion: '1.0';
  decision: 'reserved';
  allowed: true;
  decisionId: string;
  operationId: string;
  reservationId: string;
  state: 'reserved';
  reservedUsd: string;
  remainingUsd: string | null;
  expiresAt: string;
  warnings: BudgetControlWarning[];
}

export interface BypassedUsageResult {
  schemaVersion: '1.0';
  decision: 'bypassed';
  allowed: true;
  decisionId: string | null;
  operationId: string;
  reason:
    | 'control_disabled'
    | 'no_applicable_budget'
    | 'shadow_would_allow'
    | 'shadow_would_deny'
    | 'shadow_control_unavailable';
  wouldHaveDenied: boolean | null;
  warnings: BudgetControlWarning[];
  /** True only for the legacy-mode decision produced locally without I/O. */
  local: boolean;
}

export interface UnavailableUsageResult extends PylvaUnavailableResponseEvidence {
  /** More specific SDK transport/capability reason when the wire reason is necessarily generic. */
  controlReason: PylvaControlUnavailableReasonType;
  /** True when the SDK synthesized and schema-validated this unavailable decision. */
  local: boolean;
}

export type ReserveUsageResult = ReservedUsageResult | BypassedUsageResult | UnavailableUsageResult;

type MappedReserveUsageResult = ReserveUsageResult | AuthoritativeBudgetDenial;

export interface CommitUsageResult {
  schemaVersion: '1.0';
  state: 'committed';
  reservationId: string;
  operationId: string;
  reservedUsd: string;
  actualUsd: string;
  releasedUsd: string;
  overageUsd: string;
  budgetExceededAfterCommit: boolean;
  committedAt: string;
  idempotentReplay: boolean;
  late: boolean;
}

/** Identity of the one provider/tool attempt owned by a reservation. */
export interface ControlledOperationTelemetryIdentity {
  operationId: string;
  reservationId: string;
}

interface ControlledReservationOwnership extends ControlledOperationTelemetryIdentity {
  generation: number;
}

// Module-local and non-enumerable by design: another installed SDK copy cannot
// claim this copy's receipt, even if both happen to have the same generation.
const controlledReservationOwnership = new WeakMap<object, ControlledReservationOwnership>();

/**
 * Return true only for the matching, schema-valid reserved decision produced
 * by this SDK identity. Reservation ownership survives commit uncertainty, so
 * future wrappers can skip the duplicate legacy `/events` write even when a
 * commit acknowledgement is lost.
 */
export function shouldSuppressLegacyTelemetry(
  reservationResult: unknown,
  identity: ControlledOperationTelemetryIdentity,
): boolean {
  if (typeof reservationResult !== 'object' || reservationResult === null) return false;
  const current = getConfig();
  if (current === null) return false;
  const ownership = controlledReservationOwnership.get(reservationResult);
  const candidate = reservationResult as Partial<ReservedUsageResult>;
  return (
    ownership !== undefined &&
    ownership.generation === getConfigGeneration() &&
    ownership.operationId === identity.operationId &&
    ownership.reservationId === identity.reservationId &&
    candidate.decision === 'reserved' &&
    candidate.operationId === identity.operationId &&
    candidate.reservationId === identity.reservationId
  );
}

export interface ReleaseUsageResult {
  schemaVersion: '1.0';
  state: 'released';
  reservationId: string;
  operationId: string;
  releasedUsd: string;
  releasedAt: string;
  idempotentReplay: boolean;
}

export interface ExtendUsageResult {
  schemaVersion: '1.0';
  state: 'reserved';
  reservationId: string;
  operationId: string;
  extensionId: string;
  expiresAt: string;
  idempotentReplay: boolean;
}

type CapabilityOutcome =
  | { kind: 'supported'; value: ControlCapabilities }
  | { kind: 'unsupported' };

function buildReserveRequest(
  input: ReserveUsageInput,
  mode: 'shadow' | 'enforce',
): NonNullable<ReturnType<typeof buildReserveWire>> {
  const parsed = buildReserveWire(input, mode);
  if (parsed === null) throw new PylvaControlValidationError('reserveUsage');
  return parsed;
}

function buildCommitRequest(input: CommitUsageInput): {
  reservationId: string;
  body: NonNullable<ReturnType<typeof buildCommitWire>>['body'];
} {
  const parsed = buildCommitWire(input);
  if (parsed === null) throw new PylvaControlValidationError('commitUsage');
  return parsed;
}

interface ControlReadinessInspection {
  config: RuntimeConfig;
  result: ControlReadyResult;
  unavailable: StrictTransportUnavailable | null;
}

async function inspectControlReadiness(): Promise<ControlReadinessInspection> {
  const config = requireConfig();
  const context = createStrictControlContext(config);
  try {
    const outcome = await getStrictCapabilities(context);
    if (outcome.kind === 'unsupported') {
      return {
        config,
        unavailable: null,
        result: {
          ready: false,
          supported: false,
          controlEnabled: null,
          mode: config.control.mode,
          capabilities: null,
          reason: PylvaControlUnavailableReason.UNSUPPORTED_BACKEND,
          retryable: false,
        },
      };
    }
    if (config.control.mode === ControlMode.LEGACY || !outcome.value.controlEnabled) {
      return {
        config,
        unavailable: null,
        result: {
          ready: false,
          supported: true,
          controlEnabled: outcome.value.controlEnabled,
          mode: config.control.mode,
          capabilities: outcome.value,
          reason: PylvaControlUnavailableReason.CONTROL_DISABLED,
          retryable: false,
        },
      };
    }
    return {
      config,
      unavailable: null,
      result: {
        ready: true,
        supported: true,
        controlEnabled: true,
        mode: config.control.mode,
        capabilities: outcome.value,
        reason: null,
        retryable: false,
      },
    };
  } catch (error) {
    if (!(error instanceof StrictTransportUnavailable)) throw error;
    return {
      config,
      unavailable: error,
      result: {
        ready: false,
        supported: null,
        controlEnabled: null,
        mode: config.control.mode,
        capabilities: null,
        reason: error.reason,
        retryable: error.retryable,
      },
    };
  }
}

/** Return structured readiness diagnostics without changing allow/deny behavior. */
export async function controlStatus(): Promise<ControlReadyResult> {
  return (await inspectControlReadiness()).result;
}

/** Return whether authoritative control is supported, enabled, and configured. */
export async function ready(): Promise<boolean> {
  const inspection = await inspectControlReadiness();
  if (
    inspection.unavailable !== null &&
    inspection.config.control.onUnavailable === ControlUnavailablePolicy.DENY
  ) {
    throw new PylvaControlUnavailableError({
      reason: inspection.unavailable.reason,
      retryable: inspection.unavailable.retryable,
      operation: 'ready',
      status: inspection.unavailable.status,
    });
  }
  return inspection.result.ready;
}

function reserveResponseMatchesMode(
  mode: 'shadow' | 'enforce',
  value: MappedReserveUsageResult,
): boolean {
  if (mode === ControlMode.SHADOW) return value.decision === 'bypassed';
  if (value.decision !== 'bypassed') return true;
  return (
    value.reason === BudgetBypassReason.NO_APPLICABLE_BUDGET ||
    value.reason === BudgetBypassReason.CONTROL_DISABLED
  );
}

function unavailableEvidence(value: UnavailableUsageResult): PylvaUnavailableResponseEvidence {
  return {
    schemaVersion: value.schemaVersion,
    decision: value.decision,
    allowed: value.allowed,
    decisionId: value.decisionId,
    operationId: value.operationId,
    reason: value.reason,
    retryable: value.retryable,
  };
}

function synthesizeUnavailable(
  operationId: string,
  reason: PylvaControlUnavailableReasonType,
  retryable: boolean,
): UnavailableUsageResult {
  return {
    schemaVersion: BUDGET_CONTROL_SCHEMA_VERSION,
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

function synthesizeLegacyBypass(operationId: string): BypassedUsageResult {
  return {
    schemaVersion: BUDGET_CONTROL_SCHEMA_VERSION,
    decision: 'bypassed',
    allowed: true,
    decisionId: null,
    operationId,
    reason: BudgetBypassReason.CONTROL_DISABLED,
    wouldHaveDenied: null,
    warnings: [],
    local: true,
  };
}

function throwUnavailable(value: UnavailableUsageResult, status: number | null = null): never {
  throw new PylvaControlUnavailableError({
    reason: value.controlReason,
    retryable: value.retryable,
    operation: 'reserveUsage',
    operationId: value.operationId,
    unavailableResponse: unavailableEvidence(value),
    status,
  });
}

function unavailableResult(
  config: RuntimeConfig,
  operationId: string,
  reason: PylvaControlUnavailableReasonType,
  retryable: boolean,
  status: number | null = null,
): UnavailableUsageResult {
  const unavailable = synthesizeUnavailable(operationId, reason, retryable);
  if (config.control.onUnavailable === ControlUnavailablePolicy.DENY) {
    throwUnavailable(unavailable, status);
  }
  return unavailable;
}

const DECIMAL_SCALE = 18;
const DECIMAL_FACTOR = 10n ** BigInt(DECIMAL_SCALE);

function decimalUnits(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.');
  return BigInt(whole) * DECIMAL_FACTOR + BigInt(fraction.padEnd(DECIMAL_SCALE, '0'));
}

function exactSum(values: string[]): string {
  const units = values.reduce((sum, value) => sum + decimalUnits(value), 0n);
  const whole = units / DECIMAL_FACTOR;
  const fraction = (units % DECIMAL_FACTOR)
    .toString()
    .padStart(DECIMAL_SCALE, '0')
    .replace(/0+$/, '');
  return fraction.length > 0 ? `${whole}.${fraction}` : String(whole);
}

function throwBudgetDenied(denial: AuthoritativeBudgetDenial, customerId: string): never {
  const accumulatedExact = exactSum([
    denial.committedUsd,
    denial.reservedUsd,
    denial.unresolvedUsd,
  ]);
  throw new PylvaBudgetExceeded({
    source: BudgetExceededSource.AUTHORITATIVE_CONTROL,
    rule_id: denial.decidingRule.ruleId,
    // Preserve the attempted customer's identity even when the deciding rule
    // is pooled and therefore has a null customer_id in its snapshot.
    customer_id: customerId,
    period: denial.decidingRule.period,
    period_start: denial.decidingRule.periodStart,
    limit_usd: Number(denial.limitUsd),
    accumulated_usd: Number(accumulatedExact),
    estimated_usd: Number(denial.requestedUsd),
    authoritativeDenial: denial,
  });
}

export async function reserveUsage(input: ReserveUsageInput): Promise<ReserveUsageResult> {
  const config = requireConfig();
  const configuredMode = config.control.mode;
  // Legacy has no wire mode. Validate with the nearest strict mode solely to
  // normalize IDs/defaults, then return a local control_disabled decision.
  const request = buildReserveRequest(
    input,
    configuredMode === ControlMode.SHADOW ? ControlMode.SHADOW : ControlMode.ENFORCE,
  );
  if (configuredMode === ControlMode.LEGACY) return synthesizeLegacyBypass(request.operation_id);

  const context = createStrictControlContext(config);
  const generation = context.generation;
  let capabilities: CapabilityOutcome;
  try {
    capabilities = await getStrictCapabilities(context);
  } catch (error) {
    if (!(error instanceof StrictTransportUnavailable)) throw error;
    return unavailableResult(
      config,
      request.operation_id,
      error.reason,
      error.retryable,
      error.status,
    );
  }

  if (capabilities.kind === 'unsupported' || !capabilities.value.controlEnabled) {
    const reason =
      capabilities.kind === 'unsupported'
        ? PylvaControlUnavailableReason.UNSUPPORTED_BACKEND
        : PylvaControlUnavailableReason.CONTROL_DISABLED;
    return unavailableResult(config, request.operation_id, reason, false);
  }

  let response: MappedReserveUsageResult;
  try {
    response = (await strictJsonRequest(context, {
      route: AuthenticatedRoute.CONTROL_RESERVE,
      body: request,
      parse: parseStrictReserveResponse,
    }))!;
  } catch (error) {
    if (!(error instanceof StrictTransportUnavailable)) throw error;
    return unavailableResult(
      config,
      request.operation_id,
      error.reason,
      error.retryable,
      error.status,
    );
  }

  if (response.operationId !== request.operation_id) {
    return unavailableResult(
      config,
      request.operation_id,
      PylvaControlUnavailableReason.INVALID_RESPONSE,
      false,
    );
  }
  if (!reserveResponseMatchesMode(configuredMode, response)) {
    return unavailableResult(
      config,
      request.operation_id,
      PylvaControlUnavailableReason.INVALID_RESPONSE,
      false,
    );
  }
  const mapped = response;
  if (
    mapped.decision === 'bypassed' &&
    (mapped.reason === BudgetBypassReason.CONTROL_DISABLED ||
      mapped.reason === BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE)
  ) {
    // A capability/feature race can make the backend return its wire-level
    // shadow bypass after readiness was true. The low-level SDK must still
    // expose an honest unavailable decision; it never turns uncertainty into
    // budget approval on the caller's behalf.
    const controlReason =
      mapped.reason === BudgetBypassReason.CONTROL_DISABLED
        ? PylvaControlUnavailableReason.CONTROL_DISABLED
        : PylvaControlUnavailableReason.CONTROL_UNAVAILABLE;
    return unavailableResult(
      config,
      request.operation_id,
      controlReason,
      mapped.reason === BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
    );
  }
  if (mapped.decision === 'unavailable') {
    if (config.control.onUnavailable === ControlUnavailablePolicy.DENY) {
      throwUnavailable(mapped);
    }
    return mapped;
  }
  if (mapped.decision === 'denied') {
    throwBudgetDenied(mapped, request.customer_id);
  }
  if (mapped.decision === 'reserved') {
    controlledReservationOwnership.set(mapped, {
      generation,
      operationId: mapped.operationId,
      reservationId: mapped.reservationId,
    });
  }
  return mapped;
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

async function lifecycleRequest<T>(input: {
  operation: 'commitUsage' | 'releaseUsage' | 'extendUsage';
  reservationId: string;
  suffix: 'commit' | 'release' | 'extend';
  body: unknown;
  parseResponse: (value: unknown) => T | null;
}): Promise<T> {
  const config = requireConfig();
  const context = createStrictControlContext(config);
  try {
    return (await strictJsonRequest(context, {
      route:
        input.suffix === 'commit'
          ? AuthenticatedRoute.CONTROL_COMMIT
          : input.suffix === 'release'
            ? AuthenticatedRoute.CONTROL_RELEASE
            : AuthenticatedRoute.CONTROL_EXTEND,
      reservationId: input.reservationId,
      body: input.body,
      parse: input.parseResponse,
    }))!;
  } catch (error) {
    if (error instanceof StrictTransportUnavailable) {
      lifecycleUnavailable(error, input.operation, input.reservationId);
    }
    throw error;
  }
}

export async function commitUsage(input: CommitUsageInput): Promise<CommitUsageResult> {
  const { reservationId, body } = buildCommitRequest(input);
  const value = await lifecycleRequest({
    operation: 'commitUsage',
    reservationId,
    suffix: 'commit',
    body,
    parseResponse: parseStrictCommitResponse,
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

export async function releaseUsage(input: ReleaseUsageInput): Promise<ReleaseUsageResult> {
  const parsed = buildReleaseWire(input);
  if (parsed === null) throw new PylvaControlValidationError('releaseUsage');
  const { reservationId, body } = parsed;
  const value = await lifecycleRequest({
    operation: 'releaseUsage',
    reservationId,
    suffix: 'release',
    body,
    parseResponse: parseStrictReleaseResponse,
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

export async function extendUsage(input: ExtendUsageInput): Promise<ExtendUsageResult> {
  const parsed = buildExtendWire(input);
  if (parsed === null) throw new PylvaControlValidationError('extendUsage');
  const { reservationId, body } = parsed;
  const value = await lifecycleRequest({
    operation: 'extendUsage',
    reservationId,
    suffix: 'extend',
    body,
    parseResponse: parseStrictExtendResponse,
  });
  if (value.reservationId !== reservationId || value.extensionId !== body.extension_id) {
    lifecycleUnavailable(
      new StrictTransportUnavailable(PylvaControlUnavailableReason.INVALID_RESPONSE, false),
      'extendUsage',
      reservationId,
    );
  }
  return value;
}

/**
 * Compatibility hook for source-level internal callers. The canonical strict
 * runtime owns identity cleanup; public receipt ownership is generation-bound.
 */
export function _resetControlClientForIdentityChange(): void {
  // Intentionally empty: registering this facade as a second resetter would
  // advance the canonical epoch twice for one identity change.
}

/** Test-only alias; intentionally absent from the package root. */
export function _resetControlClientForTests(): void {
  _resetStrictControlForTests();
}
