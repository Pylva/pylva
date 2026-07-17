// One authoritative reservation per real provider attempt.
//
// Provider adapters validate and price their final request before entering
// this primitive. It reserves immediately before dispatch, binds lifecycle
// calls to the SDK identity that obtained the reservation, and deliberately
// leaves every post-dispatch ambiguity unresolved for backend expiry.

import { randomUUID } from 'node:crypto';
import { EventStatus, Framework } from '@pylva/shared/telemetry-values';
import { currentContext } from './context.js';
import { getConfigGeneration } from './config.js';
import { type ReserveUsageResult, type ReservedUsageResult } from './control_client.js';
import {
  ownsStrictReservation,
  strictCommitLlm,
  strictExtend,
  strictRelease,
  strictReserveLlm,
} from './strict_attempt_control.js';
import {
  linkControlledCallbackNoDispatch,
  runWithControlledOperation,
  type ControlledAttemptCorrelation,
} from './control_correlation.js';

export { currentControlledAttempt } from './control_correlation.js';
export type { ControlledAttemptCorrelation } from './control_correlation.js';

export interface ControlledAttemptOptions {
  reservationTtlSeconds?: number;
  heartbeatIntervalMs?: number;
  heartbeatExtendBySeconds?: number;
}

export interface ExecuteControlledAttemptInput<T> extends ControlledAttemptOptions {
  provider: string;
  model: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  /** Rechecked after reserve; failure proves the provider was never called. */
  predispatchCheck?: () => void;
  /** Non-throwing observer for a provider method that throws during dispatch. */
  dispatchThrew?: (error: unknown, attempt: ControlledAttemptHandle) => void;
  dispatch: () => T;
}

export interface ExactLlmUsage {
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  status?: (typeof EventStatus)[keyof typeof EventStatus];
  streamAborted?: boolean;
}

export interface ControlledAttemptHandle {
  readonly operationId: string;
  readonly receipt: ReserveUsageResult;
  readonly reservation: ReservedUsageResult | null;
  /** True only for this SDK identity's schema-valid RESERVED receipt. */
  readonly ownsReservation: boolean;
  /** Bypass/unavailable calls still need the legacy billing event. */
  readonly legacyTelemetryRequired: boolean;
  /** Identity changes make lifecycle calls inert; old reservations expire. */
  readonly identityIsCurrent: () => boolean;
  /** Idempotent and non-throwing. Commit failures never replace provider success. */
  readonly settleExact: (usage: ExactLlmUsage) => Promise<void>;
  /** Extend only while a stream is actively consumed. */
  readonly startHeartbeat: () => () => void;
}

export interface ControlledAttemptDispatch<T> {
  value: T;
  attempt: ControlledAttemptHandle;
}

export function safeUint32(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 4_294_967_295
  );
}

function normalizedAttemptOptions(
  reservationTtlSeconds: number | undefined,
  heartbeatIntervalMs: number | undefined,
  heartbeatExtendBySeconds: number | undefined,
): readonly [intervalMs: number, extendBySeconds: number] {
  const ttlSeconds = reservationTtlSeconds ?? 300;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 30 || ttlSeconds > 3_600) {
    throw new TypeError('[pylva] reservationTtlSeconds must be an integer from 30 to 3600');
  }
  const intervalMs = heartbeatIntervalMs ?? Math.min(120_000, Math.floor((ttlSeconds * 1_000) / 3));
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs >= ttlSeconds * 1_000) {
    throw new TypeError(
      '[pylva] heartbeatIntervalMs must be at least 1000 and less than the reservation TTL',
    );
  }
  const extendBySeconds = heartbeatExtendBySeconds ?? Math.max(300, ttlSeconds);
  if (
    !Number.isSafeInteger(extendBySeconds) ||
    extendBySeconds < ttlSeconds ||
    extendBySeconds > 3_600
  ) {
    throw new TypeError(
      '[pylva] heartbeatExtendBySeconds must cover the reservation TTL and be at most 3600',
    );
  }
  return [intervalMs, extendBySeconds];
}

function createAttemptHandle(
  receipt: ReserveUsageResult,
  operationId: string,
  generation: number,
  options: readonly [intervalMs: number, extendBySeconds: number],
): ControlledAttemptHandle {
  const reservation = receipt.decision === 'reserved' ? receipt : null;
  const ownsReservation =
    reservation !== null &&
    ownsStrictReservation(reservation, operationId, reservation.reservationId);
  let settlement: Promise<void> | null = null;
  let heartbeatStop: (() => void) | null = null;
  const identityIsCurrent = (): boolean => generation === getConfigGeneration();

  const settleExact = (usage: ExactLlmUsage): Promise<void> => {
    if (settlement !== null) return settlement;
    settlement = (async () => {
      if (!ownsReservation || reservation === null || !identityIsCurrent()) return;
      if (
        !safeUint32(usage.inputTokens) ||
        !safeUint32(usage.outputTokens) ||
        !Number.isSafeInteger(usage.latencyMs) ||
        usage.latencyMs < 0
      ) {
        // Unsafe evidence is not converted into an incorrect commit.
        return;
      }
      try {
        await strictCommitLlm({
          reservationId: reservation.reservationId,
          actualInputTokens: usage.inputTokens,
          actualOutputTokens: usage.outputTokens,
          latencyMs: usage.latencyMs,
          status: usage.status ?? EventStatus.SUCCESS,
          streamAborted: usage.streamAborted ?? false,
        });
      } catch {
        // A lost commit acknowledgement is ambiguous. Keep ownership so the
        // legacy event is not duplicated; replay/expiry resolves the ledger.
      }
    })().finally(() => {
      heartbeatStop?.();
    });
    return settlement;
  };

  const startHeartbeat = (): (() => void) => {
    if (!ownsReservation || reservation === null || !identityIsCurrent()) return () => {};
    if (heartbeatStop !== null) return heartbeatStop;
    const [intervalMs, extendBySeconds] = options;
    let stopped = false;
    let inFlight = false;
    const timer = setInterval(() => {
      if (stopped || inFlight) return;
      if (!identityIsCurrent()) {
        heartbeatStop?.();
        return;
      }
      inFlight = true;
      void strictExtend(reservation.reservationId, randomUUID(), extendBySeconds)
        .catch(() => {
          // Heartbeat uncertainty cannot alter provider stream behavior.
        })
        .finally(() => {
          inFlight = false;
        });
    }, intervalMs);
    timer.unref?.();
    heartbeatStop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
    };
    return heartbeatStop;
  };

  return Object.freeze({
    operationId,
    receipt,
    reservation,
    ownsReservation,
    legacyTelemetryRequired: !ownsReservation,
    identityIsCurrent,
    settleExact,
    startHeartbeat,
  });
}

/**
 * Reserve immediately before exactly one provider dispatch.
 *
 * `dispatch` is intentionally synchronous: it returns the provider's native
 * lazy promise/stream object without awaiting it. A thrown/rejected provider
 * call is post-reservation ambiguity and is never automatically released.
 */
export async function executeControlledAttempt<T>(
  input: ExecuteControlledAttemptInput<T>,
): Promise<ControlledAttemptDispatch<T>> {
  // The reservation is an asynchronous trust boundary. Snapshot every caller-
  // controlled value once before crossing it so later mutation cannot change
  // the authorized provider/model, correlation, checks, or dispatched closure.
  const {
    provider,
    model,
    estimatedInputTokens,
    maxOutputTokens,
    reservationTtlSeconds,
    heartbeatIntervalMs,
    heartbeatExtendBySeconds,
    predispatchCheck,
    dispatchThrew,
    dispatch,
  } = input;
  const attemptOptions = normalizedAttemptOptions(
    reservationTtlSeconds,
    heartbeatIntervalMs,
    heartbeatExtendBySeconds,
  );
  const generation = getConfigGeneration();
  const context = currentContext();
  const operationId = randomUUID();
  const spanId = randomUUID();
  const traceId = context?.trace_id ?? randomUUID();
  const customerId = context?.customer_id ?? 'anonymous';
  const parentSpanId = context?.span_id ?? null;
  const linkNoDispatch = (): void =>
    linkControlledCallbackNoDispatch({
      kind: 'llm',
      configGeneration: generation,
      operationId,
    });
  let receipt: ReserveUsageResult;
  try {
    receipt = await strictReserveLlm({
      operationId,
      customerId,
      traceId,
      spanId,
      parentSpanId,
      stepName: context?.step_name ?? null,
      framework: context?.framework ?? Framework.NONE,
      ...(reservationTtlSeconds !== undefined ? { reservationTtlSeconds } : {}),
      provider,
      model,
      estimatedInputTokens,
      maxOutputTokens,
    });
  } catch (error) {
    linkNoDispatch();
    throw error;
  }
  const attempt = createAttemptHandle(receipt, operationId, generation, attemptOptions);

  // A RESERVED receipt whose private ownership token was invalidated between
  // reserve and dispatch is not permission for a call under the new identity.
  if (attempt.reservation !== null && !attempt.ownsReservation) {
    linkNoDispatch();
    throw new Error('[pylva] budget-control identity changed before provider dispatch');
  }

  try {
    predispatchCheck?.();
  } catch (error) {
    linkNoDispatch();
    if (attempt.ownsReservation && attempt.reservation !== null && attempt.identityIsCurrent()) {
      try {
        await strictRelease(attempt.reservation.reservationId, 'provider_not_called');
      } catch {
        // The provider was definitely not called. Preserve the local refusal;
        // backend idempotency/expiry resolves a lost release acknowledgement.
      }
    }
    throw error;
  }

  const correlation: ControlledAttemptCorrelation = Object.freeze({
    operationId,
    reservationId: attempt.reservation?.reservationId ?? null,
    traceId,
    spanId,
    parentSpanId,
    customerId,
    provider,
    model,
    ownsReservation: attempt.ownsReservation,
    legacyTelemetryRequired: attempt.legacyTelemetryRequired,
  });
  try {
    return {
      value: runWithControlledOperation(
        { ...correlation, kind: 'llm', configGeneration: generation },
        dispatch,
        // Provider APIPromise helpers may be lazy and body-consuming. Exact
        // callback rendezvous is linked before dispatch, so end the active
        // context at synchronous return without touching `.then()`.
        { lifetime: 'invoke' },
      ),
      attempt,
    };
  } catch (error) {
    // A synchronous provider throw is still a post-dispatch outcome. Expose
    // the already-created attempt to telemetry owners without allowing their
    // observer to replace the provider's original exception.
    try {
      dispatchThrew?.(error, attempt);
    } catch {
      // Telemetry is non-fatal.
    }
    throw error;
  }
}
