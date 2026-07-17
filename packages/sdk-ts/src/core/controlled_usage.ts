// Authoritative control for one bounded, non-LLM provider attempt.
//
// Only content-free pricing identity and exact decimal quantities enter the
// control transport. Tool arguments, queries, URLs, provider responses, and
// provider exception text remain inside the invocation closure.

import { randomUUID } from 'node:crypto';
import { isProxy } from 'node:util/types';
import { currentContext } from './context.js';
import {
  linkControlledCallbackNoDispatch,
  linkLocalControlledCallbackNoDispatch,
  runWithControlledOperation,
} from './control_correlation.js';
import {
  commitUsage,
  extendUsage,
  releaseUsage,
  reserveUsage,
  shouldSuppressLegacyTelemetry,
  type CommitUsageResult,
  type ExactDecimalInput,
  type ReserveUsageResult,
  type ReservedUsageResult,
} from './control_client.js';
import { ControlMode, getConfigGeneration, requireConfig, type RuntimeConfig } from './config.js';
import {
  PylvaControlApiError,
  PylvaControlUnavailableError,
  PylvaControlUnavailableReason,
  PylvaControlValidationError,
} from '../errors/control.js';
import { reportUsage } from '../reporting/usage.js';

export type ControlledUsageDecision = 'reserved' | 'bypassed' | 'unavailable';
export type ControlledUsageSettlement = 'committed' | 'bypassed' | 'unavailable' | 'unresolved';
export type ControlledUsageIssue =
  | 'usage_extraction_failed'
  | 'commit_failed'
  | 'configuration_changed'
  | 'extension_failed'
  | 'legacy_report_failed';

function validationError(operation: string): PylvaControlValidationError {
  linkLocalControlledCallbackNoDispatch('tool');
  return new PylvaControlValidationError(operation);
}

export interface ControlledUsageOutcome {
  operationId: string;
  reservationId: string | null;
  decision: ControlledUsageDecision;
  decisionReason: string | null;
  settlement: ControlledUsageSettlement;
  maximumValue: string;
  actualValue: string | null;
  boundViolated: boolean | null;
  authoritativeOwnership: boolean;
  legacyTelemetryEmitted: boolean;
  issue: ControlledUsageIssue | null;
  commit: CommitUsageResult | null;
}

export interface ControlledUsageResult<T> {
  value: T;
  control: ControlledUsageOutcome;
}

export interface ControlledUsageInput<T> {
  costSourceSlug: string;
  toolName: string;
  metric: string;
  maximumValue: ExactDecimalInput;
  invoke: () => T | Promise<T>;
  extractActual: (value: T) => ExactDecimalInput | Promise<ExactDecimalInput>;
  customerId?: string;
  step?: string;
  /** Synchronous local preparation after reservation but before provider dispatch. */
  beforeInvoke?: () => void;
  reservationTtlSeconds?: number;
  /** Primarily useful for short-lived test environments; must be shorter than the TTL. */
  heartbeatIntervalMs?: number;
}

export interface ControlledExactUsageInput<T> extends Omit<
  ControlledUsageInput<T>,
  'maximumValue' | 'extractActual'
> {
  value: ExactDecimalInput;
}

const DECIMAL_RE = /^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/;
const INPUT_KEYS = new Set([
  'costSourceSlug',
  'toolName',
  'metric',
  'maximumValue',
  'invoke',
  'extractActual',
  'customerId',
  'step',
  'beforeInvoke',
  'reservationTtlSeconds',
  'heartbeatIntervalMs',
]);
const EXACT_INPUT_KEYS = new Set([
  'costSourceSlug',
  'toolName',
  'metric',
  'value',
  'invoke',
  'customerId',
  'step',
  'beforeInvoke',
  'reservationTtlSeconds',
  'heartbeatIntervalMs',
]);

interface Attempt {
  operationId: string;
  customerId: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  stepName: string | null;
  framework: 'langgraph' | 'crewai' | 'mastra' | 'openai-agents' | 'pydantic-ai' | 'none';
  generation: number;
  config: RuntimeConfig;
}

function strictInput(value: unknown, keys: ReadonlySet<string>, operation: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || isProxy(value)) {
    throw validationError(operation);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw validationError(operation);
  }
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || key === '__proto__' || !keys.has(key)) {
      throw validationError(operation);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw validationError(operation);
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return snapshot;
}

function canonicalDecimal(value: unknown, operation: string): string {
  let text: unknown = value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw validationError(operation);
    }
    text = String(Object.is(value, -0) ? 0 : value);
  }
  if (typeof text !== 'string' || !DECIMAL_RE.test(text)) {
    throw validationError(operation);
  }
  if (!text.includes('.')) return text;
  const canonical = text.replace(/0+$/, '').replace(/\.$/, '');
  return canonical || '0';
}

function decimalUnits(value: string): bigint {
  const [integer, fraction = ''] = value.split('.');
  return BigInt(integer!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0') || '0');
}

function attempt(customerId: unknown, step: unknown): Attempt {
  const config = requireConfig();
  const context = currentContext();
  const resolvedCustomer = customerId ?? context?.customer_id;
  if (typeof resolvedCustomer !== 'string') {
    throw validationError('controlledUsage');
  }
  if (step !== undefined && typeof step !== 'string') {
    throw validationError('controlledUsage');
  }
  return {
    operationId: randomUUID(),
    customerId: resolvedCustomer,
    traceId: context?.trace_id ?? randomUUID(),
    spanId: randomUUID(),
    parentSpanId: context?.span_id ?? null,
    stepName: (step as string | undefined) ?? context?.step_name ?? null,
    framework: context?.framework ?? 'none',
    generation: getConfigGeneration(),
    config,
  };
}

function heartbeatInterval(
  ttlSeconds: unknown,
  intervalMs: unknown,
): {
  ttlSeconds: number;
  intervalMs: number;
} {
  const ttl = ttlSeconds ?? 300;
  if (!Number.isSafeInteger(ttl) || (ttl as number) < 30 || (ttl as number) > 3_600) {
    throw validationError('controlledUsage');
  }
  const resolved =
    intervalMs ?? Math.max(Math.min((ttl as number) * 500, (ttl as number) * 1_000 - 5_000), 1_000);
  if (
    typeof resolved !== 'number' ||
    !Number.isFinite(resolved) ||
    resolved <= 0 ||
    resolved >= (ttl as number) * 1_000
  ) {
    throw validationError('controlledUsage');
  }
  return { ttlSeconds: ttl as number, intervalMs: resolved };
}

function configurationChanged(value: Attempt): boolean {
  const current = (() => {
    try {
      return requireConfig();
    } catch {
      return null;
    }
  })();
  return (
    current === null ||
    getConfigGeneration() !== value.generation ||
    current.endpoint !== value.config.endpoint
  );
}

function configurationChangedError(operationId: string): PylvaControlUnavailableError {
  return new PylvaControlUnavailableError({
    reason: PylvaControlUnavailableReason.CONFIGURATION_CHANGED,
    retryable: true,
    operation: 'reserveUsage',
    operationId,
  });
}

function warn(issue: ControlledUsageIssue): void {
  // Provider error text is deliberately excluded because it may contain arguments or URLs.
  console.warn(
    `[pylva] controlledUsage settlement=${issue}; authoritative usage may remain unresolved`,
  );
}

class ReservationHeartbeat {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private stopped = false;
  failed = false;

  constructor(
    private readonly reservationId: string,
    private readonly intervalMs: number,
    private readonly extendBySeconds: number,
  ) {}

  start(): void {
    this.timer = setTimeout(() => this.tick(), this.intervalMs);
  }

  private tick(): void {
    if (this.stopped) return;
    this.inFlight = extendUsage({
      reservationId: this.reservationId,
      extensionId: randomUUID(),
      extendBySeconds: this.extendBySeconds,
    })
      .then(() => {
        if (!this.stopped) this.timer = setTimeout(() => this.tick(), this.intervalMs);
      })
      .catch(() => {
        this.failed = true;
      })
      .then(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    if (this.inFlight !== null) await this.inFlight;
  }
}

async function releaseBeforeDispatch(reservation: ReservedUsageResult): Promise<void> {
  try {
    await releaseUsage({
      reservationId: reservation.reservationId,
      reason: 'provider_not_called',
    });
  } catch {
    // Preserve the caller's local pre-dispatch exception. The hold safely expires.
  }
}

async function reserveForMode(
  input: Parameters<typeof reserveUsage>[0],
  mode: RuntimeConfig['control']['mode'],
): Promise<ReserveUsageResult | null> {
  try {
    return await reserveUsage(input);
  } catch (error) {
    if (
      mode === ControlMode.SHADOW &&
      (error instanceof PylvaControlUnavailableError || error instanceof PylvaControlApiError)
    ) {
      return null;
    }
    throw error;
  }
}

function decisionReason(reservation: ReserveUsageResult | null): string | null {
  if (reservation === null) return 'shadow_control_unavailable';
  if (reservation.decision === 'bypassed' || reservation.decision === 'unavailable') {
    return reservation.reason;
  }
  return null;
}

function uncontrolledOutcome(input: {
  reservation: ReserveUsageResult | null;
  attempt: Attempt;
  maximumValue: string;
  actualValue: string | null;
  issue: ControlledUsageIssue | null;
  legacyEmitted: boolean;
}): ControlledUsageOutcome {
  const decision: ControlledUsageDecision = input.reservation?.decision ?? 'unavailable';
  return {
    operationId: input.attempt.operationId,
    reservationId: null,
    decision,
    decisionReason: decisionReason(input.reservation),
    settlement:
      input.issue === 'usage_extraction_failed' || input.issue === 'configuration_changed'
        ? 'unresolved'
        : decision === 'bypassed'
          ? 'bypassed'
          : 'unavailable',
    maximumValue: input.maximumValue,
    actualValue: input.actualValue,
    boundViolated:
      input.actualValue === null
        ? null
        : decimalUnits(input.actualValue) > decimalUnits(input.maximumValue),
    authoritativeOwnership: false,
    legacyTelemetryEmitted: input.legacyEmitted,
    issue: input.issue,
    commit: null,
  };
}

function reservedOutcome(input: {
  reservation: ReservedUsageResult;
  maximumValue: string;
  actualValue: string | null;
  settlement: 'committed' | 'unresolved';
  issue: ControlledUsageIssue | null;
  commit?: CommitUsageResult | null;
}): ControlledUsageOutcome {
  return {
    operationId: input.reservation.operationId,
    reservationId: input.reservation.reservationId,
    decision: 'reserved',
    decisionReason: null,
    settlement: input.settlement,
    maximumValue: input.maximumValue,
    actualValue: input.actualValue,
    boundViolated:
      input.actualValue === null
        ? null
        : decimalUnits(input.actualValue) > decimalUnits(input.maximumValue),
    authoritativeOwnership: true,
    legacyTelemetryEmitted: false,
    issue: input.issue,
    commit: input.commit ?? null,
  };
}

function legacyReport(input: {
  toolName: string;
  metric: string;
  actualValue: string;
  customerId: string;
  stepName: string | null;
}): boolean {
  try {
    const value = Number(input.actualValue);
    if (!Number.isFinite(value)) throw new TypeError('invalid legacy quantity');
    reportUsage({
      tool: input.toolName,
      metric: input.metric,
      value,
      customer_id: input.customerId,
      step: input.stepName ?? undefined,
    });
    return true;
  } catch {
    warn('legacy_report_failed');
    return false;
  }
}

/** Run one Promise-returning bounded tool call under authoritative control. */
export async function controlledUsage<T>(
  rawInput: ControlledUsageInput<T>,
): Promise<ControlledUsageResult<T>> {
  const operation = 'controlledUsage';
  const input = strictInput(rawInput, INPUT_KEYS, operation);
  // Snapshot every validated dispatch field before reserveUsage can yield.
  // Callers retain the raw input object, so reading it again after reserve
  // would let them replace the invocation or pricing identity mid-attempt.
  const costSourceSlug = input['costSourceSlug'];
  const toolName = input['toolName'];
  const metric = input['metric'];
  const invokeCandidate = input['invoke'];
  const extractActualCandidate = input['extractActual'];
  const beforeInvokeCandidate = input['beforeInvoke'];
  const maximumInput = input['maximumValue'];
  const customerId = input['customerId'];
  const step = input['step'];
  const reservationTtlSeconds = input['reservationTtlSeconds'];
  const heartbeatIntervalMs = input['heartbeatIntervalMs'];
  if (
    typeof costSourceSlug !== 'string' ||
    typeof toolName !== 'string' ||
    typeof metric !== 'string' ||
    typeof invokeCandidate !== 'function' ||
    typeof extractActualCandidate !== 'function'
  ) {
    throw validationError(operation);
  }
  if (beforeInvokeCandidate !== undefined && typeof beforeInvokeCandidate !== 'function') {
    throw validationError(operation);
  }
  const invoke = invokeCandidate as () => T | Promise<T>;
  const extractActual = extractActualCandidate as (
    value: T,
  ) => ExactDecimalInput | Promise<ExactDecimalInput>;
  const beforeInvoke = beforeInvokeCandidate as (() => unknown) | undefined;
  const maximumValue = canonicalDecimal(maximumInput, operation);
  const heartbeat = heartbeatInterval(reservationTtlSeconds, heartbeatIntervalMs);
  const operationAttempt = attempt(customerId, step);
  const linkNoDispatch = (): void =>
    linkControlledCallbackNoDispatch({
      kind: 'tool',
      configGeneration: operationAttempt.generation,
      operationId: operationAttempt.operationId,
    });
  let reservation: ReserveUsageResult | null;
  try {
    reservation = await reserveForMode(
      {
        kind: 'tool',
        operationId: operationAttempt.operationId,
        customerId: operationAttempt.customerId,
        traceId: operationAttempt.traceId,
        spanId: operationAttempt.spanId,
        parentSpanId: operationAttempt.parentSpanId,
        stepName: operationAttempt.stepName,
        framework: operationAttempt.framework,
        reservationTtlSeconds: heartbeat.ttlSeconds,
        costSourceSlug,
        toolName,
        metric,
        maximumValue,
      },
      operationAttempt.config.control.mode,
    );
  } catch (error) {
    linkNoDispatch();
    throw error;
  }
  if (configurationChanged(operationAttempt)) {
    linkNoDispatch();
    throw configurationChangedError(operationAttempt.operationId);
  }

  if (reservation?.decision === 'reserved') {
    if (
      !shouldSuppressLegacyTelemetry(reservation, {
        operationId: reservation.operationId,
        reservationId: reservation.reservationId,
      })
    ) {
      linkNoDispatch();
      throw new PylvaControlValidationError(operation);
    }
    const reservationHeartbeat = new ReservationHeartbeat(
      reservation.reservationId,
      heartbeat.intervalMs,
      heartbeat.ttlSeconds,
    );
    try {
      if (beforeInvoke !== undefined && beforeInvoke() !== undefined) {
        throw new PylvaControlValidationError(operation);
      }
      if (configurationChanged(operationAttempt)) {
        throw configurationChangedError(operationAttempt.operationId);
      }
      reservationHeartbeat.start();
    } catch (error) {
      linkNoDispatch();
      if (!configurationChanged(operationAttempt)) await releaseBeforeDispatch(reservation);
      throw error;
    }

    const startedAt = Date.now();
    let value: T;
    let actualValue: string | null = null;
    let extractionFailed = false;
    let changedAfterProvider = false;
    let latencyMs = 0;
    try {
      value = await runWithControlledOperation(
        {
          kind: 'tool',
          configGeneration: operationAttempt.generation,
          operationId: operationAttempt.operationId,
          reservationId: reservation.reservationId,
          traceId: operationAttempt.traceId,
          spanId: operationAttempt.spanId,
          parentSpanId: operationAttempt.parentSpanId,
          customerId: operationAttempt.customerId,
          ownsReservation: true,
          legacyTelemetryRequired: false,
          costSourceSlug,
          toolName,
          metric,
        },
        invoke,
      ); // dispatch begins immediately before this expression
      latencyMs = Math.min(Math.max(Date.now() - startedAt, 0), 4_294_967_295);
      changedAfterProvider = configurationChanged(operationAttempt);
      if (!changedAfterProvider) {
        try {
          actualValue = canonicalDecimal(await extractActual(value), operation);
        } catch {
          extractionFailed = true;
        }
      }
    } finally {
      await reservationHeartbeat.stop();
    }
    if (changedAfterProvider || configurationChanged(operationAttempt)) {
      warn('configuration_changed');
      return {
        value,
        control: reservedOutcome({
          reservation,
          maximumValue,
          actualValue: null,
          settlement: 'unresolved',
          issue: 'configuration_changed',
        }),
      };
    }
    const extensionIssue: ControlledUsageIssue | null = reservationHeartbeat.failed
      ? 'extension_failed'
      : null;
    if (extensionIssue !== null) warn(extensionIssue);

    if (extractionFailed || actualValue === null) {
      warn('usage_extraction_failed');
      return {
        value,
        control: reservedOutcome({
          reservation,
          maximumValue,
          actualValue: null,
          settlement: 'unresolved',
          issue: 'usage_extraction_failed',
        }),
      };
    }
    let commit: CommitUsageResult;
    try {
      commit = await commitUsage({
        reservationId: reservation.reservationId,
        kind: 'tool',
        actualValue,
        status: 'success',
        latencyMs,
        streamAborted: false,
      });
    } catch {
      warn('commit_failed');
      return {
        value,
        control: reservedOutcome({
          reservation,
          maximumValue,
          actualValue,
          settlement: 'unresolved',
          issue: 'commit_failed',
        }),
      };
    }
    return {
      value,
      control: reservedOutcome({
        reservation,
        maximumValue,
        actualValue,
        settlement: 'committed',
        issue: extensionIssue,
        commit,
      }),
    };
  }

  try {
    if (beforeInvoke !== undefined && beforeInvoke() !== undefined) {
      throw new PylvaControlValidationError(operation);
    }
  } catch (error) {
    linkNoDispatch();
    throw error;
  }
  const value = await runWithControlledOperation(
    {
      kind: 'tool',
      configGeneration: operationAttempt.generation,
      operationId: operationAttempt.operationId,
      reservationId: null,
      traceId: operationAttempt.traceId,
      spanId: operationAttempt.spanId,
      parentSpanId: operationAttempt.parentSpanId,
      customerId: operationAttempt.customerId,
      ownsReservation: false,
      legacyTelemetryRequired: true,
      costSourceSlug,
      toolName,
      metric,
    },
    invoke,
  );
  if (configurationChanged(operationAttempt)) {
    warn('configuration_changed');
    return {
      value,
      control: uncontrolledOutcome({
        reservation,
        attempt: operationAttempt,
        maximumValue,
        actualValue: null,
        issue: 'configuration_changed',
        legacyEmitted: false,
      }),
    };
  }
  let actualValue: string;
  try {
    actualValue = canonicalDecimal(await extractActual(value), operation);
  } catch {
    warn('usage_extraction_failed');
    return {
      value,
      control: uncontrolledOutcome({
        reservation,
        attempt: operationAttempt,
        maximumValue,
        actualValue: null,
        issue: 'usage_extraction_failed',
        legacyEmitted: false,
      }),
    };
  }
  if (configurationChanged(operationAttempt)) {
    warn('configuration_changed');
    return {
      value,
      control: uncontrolledOutcome({
        reservation,
        attempt: operationAttempt,
        maximumValue,
        actualValue: null,
        issue: 'configuration_changed',
        legacyEmitted: false,
      }),
    };
  }
  const emitted = legacyReport({
    toolName,
    metric,
    actualValue,
    customerId: operationAttempt.customerId,
    stepName: operationAttempt.stepName,
  });
  return {
    value,
    control: uncontrolledOutcome({
      reservation,
      attempt: operationAttempt,
      maximumValue,
      actualValue,
      issue: emitted ? null : 'legacy_report_failed',
      legacyEmitted: emitted,
    }),
  };
}

/** Control a call whose exact quantity is known before provider dispatch. */
export async function controlledExactUsage<T>(
  rawInput: ControlledExactUsageInput<T>,
): Promise<ControlledUsageResult<T>> {
  const input = strictInput(rawInput, EXACT_INPUT_KEYS, 'controlledExactUsage');
  const value = canonicalDecimal(input['value'], 'controlledExactUsage');
  return controlledUsage({
    costSourceSlug: input['costSourceSlug'] as string,
    toolName: input['toolName'] as string,
    metric: input['metric'] as string,
    maximumValue: value,
    invoke: input['invoke'] as () => T | Promise<T>,
    extractActual: () => value,
    customerId: input['customerId'] as string | undefined,
    step: input['step'] as string | undefined,
    beforeInvoke: input['beforeInvoke'] as (() => void) | undefined,
    reservationTtlSeconds: input['reservationTtlSeconds'] as number | undefined,
    heartbeatIntervalMs: input['heartbeatIntervalMs'] as number | undefined,
  });
}
