// Exact correlation for one authoritative-control provider dispatch.
//
// Both LLM wrappers and controlled non-LLM helpers enter this context only
// around the real provider invocation. Framework callbacks can therefore
// attribute and de-duplicate the matching run without model/name/time
// heuristics. Nested and concurrent operations are isolated by
// AsyncLocalStorage.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { getConfigGeneration } from './config.js';

interface ControlledOperationCorrelationBase {
  /** SDK identity generation that obtained this dispatch decision. */
  readonly configGeneration: number;
  readonly operationId: string;
  readonly reservationId: string | null;
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly customerId: string;
  readonly ownsReservation: boolean;
  readonly legacyTelemetryRequired: boolean;
}

export interface ControlledLlmOperationCorrelation extends ControlledOperationCorrelationBase {
  readonly kind: 'llm';
  readonly provider: string;
  readonly model: string;
}

/** Public, credential-free view of the authoritative LLM dispatch in scope. */
export interface ControlledAttemptCorrelation {
  operationId: string;
  reservationId: string | null;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  customerId: string;
  provider: string;
  model: string;
  ownsReservation: boolean;
  legacyTelemetryRequired: boolean;
}

export interface ControlledToolOperationCorrelation extends ControlledOperationCorrelationBase {
  readonly kind: 'tool';
  readonly costSourceSlug: string;
  readonly toolName: string;
  readonly metric: string;
}

export type ControlledOperationCorrelation =
  | ControlledLlmOperationCorrelation
  | ControlledToolOperationCorrelation;

export interface ControlledNoDispatchCorrelation {
  readonly kind: ControlledOperationCorrelation['kind'];
  readonly configGeneration: number;
  readonly operationId: string;
}

export interface ControlledOperationScopeOptions {
  /**
   * `settled` keeps async user/tool invocation context active until its Promise
   * settles. `invoke` ends at the synchronous dispatch return and never
   * observes a provider-specific lazy Promise.
   */
  readonly lifetime?: 'invoke' | 'settled';
}

interface ControlledOperationLease {
  readonly correlation: ControlledOperationCorrelation;
  active: boolean;
}

export interface ControlledCallbackLink {
  readonly kind: ControlledOperationCorrelation['kind'];
  readonly configGeneration: number;
  controlledOperation: ControlledOperationCorrelation | null;
  controlledNoDispatch: ControlledNoDispatchCorrelation | null;
  ambiguous: boolean;
  /** Owning rendezvous while this callback is still waiting for dispatch. */
  scope: ControlledCallbackScope | null;
}

interface ControlledCallbackScope {
  readonly pending: Set<ControlledCallbackLink>;
  readonly warned: Set<ControlledOperationCorrelation['kind']>;
  /** Same-kind operation already active outside this invocation boundary. */
  readonly inheritedOperation: ControlledOperationCorrelation | null;
  active: boolean;
}

// Published entrypoints import this one physical canonical CJS module. The
// ALS instances and mutable rendezvous stay inside its closure.
const activeOperation = new AsyncLocalStorage<ControlledOperationLease>();
const callbackScope = new AsyncLocalStorage<ControlledCallbackScope>();

/** Create one exact callback-to-provider rendezvous for a model/tool invoke. */
export function withControlledCallbackScope<T>(invoke: () => T): T {
  const scope: ControlledCallbackScope = {
    pending: new Set(),
    warned: new Set(),
    inheritedOperation: currentControlledOperation() ?? null,
    active: true,
  };
  try {
    const value = callbackScope.run(scope, invoke);
    deactivateWhenSettled(value, () => deactivateCallbackScope(scope));
    return value;
  } catch (error) {
    deactivateCallbackScope(scope);
    throw error;
  }
}

/** Register one callback run before its provider helper reaches dispatch. */
export function registerControlledCallback(
  kind: ControlledOperationCorrelation['kind'],
): ControlledCallbackLink | null {
  const scope = callbackScope.getStore();
  if (!scope?.active) return null;
  const link: ControlledCallbackLink = {
    kind,
    configGeneration: getConfigGeneration(),
    controlledOperation: null,
    controlledNoDispatch: null,
    ambiguous: false,
    scope,
  };
  scope.pending.add(link);
  return link;
}

/** Remove terminal callback state from its invocation scope. */
export function completeControlledCallback(link: ControlledCallbackLink | null): void {
  if (link === null) return;
  link.scope?.pending.delete(link);
  link.scope = null;
}

/**
 * Capture a same-kind operation only if it began inside this invocation.
 *
 * An operation already active when the public control scope was created is an
 * outer call. Treating it as the inner callback owner could hide nested spend.
 */
export function controlledOperationForCallbackStart(
  kind: ControlledOperationCorrelation['kind'],
): ControlledOperationCorrelation | null {
  const operation = currentControlledOperation();
  if (operation?.kind !== kind) return null;
  const scope = callbackScope.getStore();
  if (scope?.active && scope.inheritedOperation === operation) return null;
  return operation;
}

/** Mark the exact pending callback as an SDK-owned pre-dispatch refusal. */
export function linkControlledCallbackNoDispatch(
  correlation: ControlledNoDispatchCorrelation,
): void {
  const immutable = Object.freeze({ ...correlation });
  try {
    const candidate = takeOnlyPendingCallback(immutable.kind, immutable.configGeneration, false);
    if (candidate !== null) candidate.controlledNoDispatch = immutable;
  } catch {
    // Callback correlation is observer-only and cannot replace the original
    // control refusal or local pre-dispatch error.
  }
}

/** Link a validation refusal that occurs before a provider/tool attempt exists. */
export function linkLocalControlledCallbackNoDispatch(
  kind: ControlledOperationCorrelation['kind'],
): void {
  try {
    linkControlledCallbackNoDispatch({
      kind,
      configGeneration: getConfigGeneration(),
      operationId: randomUUID(),
    });
  } catch {
    // Correlation is observer-only and must never replace the local error.
  }
}

function deactivateCallbackScope(scope: ControlledCallbackScope): void {
  if (!scope.active) return;
  scope.active = false;
  for (const link of scope.pending) {
    link.ambiguous = true;
    link.scope = null;
  }
  scope.pending.clear();
}

function deactivateWhenSettled<T>(value: T, deactivate: () => void): void {
  try {
    if (
      value !== null &&
      (typeof value === 'object' || typeof value === 'function') &&
      typeof (value as { then?: unknown }).then === 'function'
    ) {
      // Observe settlement without replacing provider-specific Promise subclasses.
      // Both branches resolve the observer promise, so this cannot create an
      // unhandled rejection if the provider call fails.
      void Promise.resolve(value).then(deactivate, deactivate);
      return;
    }
  } catch {
    // Correlation cleanup is an observer and must not replace provider behavior.
  }
  deactivate();
}

function warnAmbiguousScope(
  scope: ControlledCallbackScope,
  kind: ControlledOperationCorrelation['kind'],
  count: number,
): void {
  if (scope.warned.has(kind)) return;
  scope.warned.add(kind);
  try {
    console.warn(
      `[pylva] LangGraph control scope found ${count} pending ${kind} callbacks; ` +
        'exact auto-deduplication was not linked. Use one control scope per billable invocation.',
    );
  } catch {
    // Diagnostics are observer-only and can never block provider dispatch.
  }
}

function linkPendingCallback(correlation: ControlledOperationCorrelation): void {
  const candidate = takeOnlyPendingCallback(correlation.kind, correlation.configGeneration);
  if (candidate !== null) candidate.controlledOperation = correlation;
}

function takeOnlyPendingCallback(
  kind: ControlledOperationCorrelation['kind'],
  configGeneration: number,
  warnOnEmpty = true,
): ControlledCallbackLink | null {
  const scope = callbackScope.getStore();
  if (!scope?.active) return null;
  const candidates = [...scope.pending].filter(
    (link) =>
      !link.ambiguous &&
      link.controlledOperation === null &&
      link.controlledNoDispatch === null &&
      link.kind === kind &&
      link.configGeneration === configGeneration,
  );
  if (candidates.length === 0) {
    if (warnOnEmpty) warnAmbiguousScope(scope, kind, 0);
    return null;
  }
  if (candidates.length > 1) {
    warnAmbiguousScope(scope, kind, candidates.length);
    for (const candidate of candidates) {
      candidate.ambiguous = true;
      scope.pending.delete(candidate);
      candidate.scope = null;
    }
    return null;
  }
  const [candidate] = candidates;
  scope.pending.delete(candidate!);
  candidate!.scope = null;
  return candidate!;
}

/** The exact controlled operation whose provider is being invoked now. */
export function currentControlledOperation(): ControlledOperationCorrelation | undefined {
  const lease = activeOperation.getStore();
  const correlation = lease?.correlation;
  return lease?.active && correlation?.configGeneration === getConfigGeneration()
    ? correlation
    : undefined;
}

/** Exact LLM correlation for callbacks; absent outside the synchronous dispatch. */
export function currentControlledAttempt(): ControlledAttemptCorrelation | undefined {
  const correlation = currentControlledOperation();
  if (correlation?.kind !== 'llm') return undefined;
  const {
    operationId,
    reservationId,
    traceId,
    spanId,
    parentSpanId,
    customerId,
    provider,
    model,
    ownsReservation,
    legacyTelemetryRequired,
  } = correlation;
  return {
    operationId,
    reservationId,
    traceId,
    spanId,
    parentSpanId,
    customerId,
    provider,
    model,
    ownsReservation,
    legacyTelemetryRequired,
  };
}

/**
 * Bind exact correlation only for the duration of one real provider invoke.
 *
 * This is an internal trust boundary: callers construct the correlation only
 * after authoritative reserve validation (or an explicit rollout bypass).
 */
export function runWithControlledOperation<T>(
  correlation: ControlledOperationCorrelation,
  invoke: () => T,
  options: ControlledOperationScopeOptions = {},
): T {
  const immutable = Object.freeze({ ...correlation }) as ControlledOperationCorrelation;
  try {
    linkPendingCallback(immutable);
  } catch {
    // Correlation is observer-only. A broken logger or rendezvous must not
    // replace the real provider call.
  }
  const lease: ControlledOperationLease = { correlation: immutable, active: true };
  try {
    const value = activeOperation.run(lease, invoke);
    const deactivate = (): void => {
      lease.active = false;
    };
    if (options.lifetime === 'invoke') deactivate();
    else deactivateWhenSettled(value, deactivate);
    return value;
  } catch (error) {
    lease.active = false;
    throw error;
  }
}
