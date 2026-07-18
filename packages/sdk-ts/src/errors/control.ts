// Public authoritative-control errors. Messages contain only stable SDK-owned
// metadata; backend bodies and transport exception text are never copied into
// errors because they may contain proxy or infrastructure details.

export const PYLVA_CONTROL_UNAVAILABLE_CODE = 'control_unavailable' as const;

export const PylvaControlUnavailableReason = {
  PRICING_UNAVAILABLE: 'pricing_unavailable',
  USAGE_BOUND_REQUIRED: 'usage_bound_required',
  CONTROL_UNAVAILABLE: 'control_unavailable',
  CONTROL_DISABLED: 'control_disabled',
  UNSUPPORTED_BACKEND: 'unsupported_backend',
  TIMEOUT: 'timeout',
  NETWORK_ERROR: 'network_error',
  INVALID_RESPONSE: 'invalid_response',
  CONFIGURATION_CHANGED: 'configuration_changed',
  RATE_LIMITED: 'rate_limited',
  SERVICE_UNAVAILABLE: 'service_unavailable',
} as const;
export type PylvaControlUnavailableReason =
  (typeof PylvaControlUnavailableReason)[keyof typeof PylvaControlUnavailableReason];

export interface PylvaUnavailableResponseEvidence {
  schemaVersion: '1.0';
  decision: 'unavailable';
  allowed: false;
  decisionId: string | null;
  operationId: string;
  reason: 'pricing_unavailable' | 'usage_bound_required' | 'control_unavailable';
  retryable: boolean;
}

export interface PylvaControlUnavailableErrorInit {
  reason: PylvaControlUnavailableReason;
  retryable: boolean;
  operation: 'ready' | 'reserveUsage' | 'commitUsage' | 'releaseUsage' | 'extendUsage';
  operationId?: string | null;
  reservationId?: string | null;
  unavailableResponse?: PylvaUnavailableResponseEvidence | null;
  status?: number | null;
}

export interface PylvaControlUnavailableError extends Error {
  readonly code: typeof PYLVA_CONTROL_UNAVAILABLE_CODE;
  readonly reason: PylvaControlUnavailableReason;
  readonly retryable: boolean;
  readonly operation: PylvaControlUnavailableErrorInit['operation'];
  readonly operationId: string | null;
  readonly reservationId: string | null;
  readonly unavailableResponse: PylvaUnavailableResponseEvidence | null;
  readonly status: number | null;
}

export interface PylvaControlApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param: string | null;
}

export interface PylvaControlValidationError extends TypeError {
  readonly operation: string;
}

interface PylvaControlUnavailableErrorConstructor extends Function {
  new (init: PylvaControlUnavailableErrorInit): PylvaControlUnavailableError;
  readonly prototype: PylvaControlUnavailableError;
}

interface PylvaControlApiErrorConstructor extends Function {
  new (status: number, code: string, param?: string | null): PylvaControlApiError;
  readonly prototype: PylvaControlApiError;
}

interface PylvaControlValidationErrorConstructor extends Function {
  new (operation: string): PylvaControlValidationError;
  readonly prototype: PylvaControlValidationError;
}

// Published entrypoints all import one physical error CJS module. Module-cache
// identity, rather than a process-global constructor registry, keeps public
// `instanceof` behavior stable across ESM, CommonJS, root, and deep imports.
export const PylvaControlUnavailableError = class PylvaControlUnavailableError
  extends Error
  implements PylvaControlUnavailableError
{
  readonly code = PYLVA_CONTROL_UNAVAILABLE_CODE;
  declare readonly reason: PylvaControlUnavailableReason;
  declare readonly retryable: boolean;
  declare readonly operation: PylvaControlUnavailableErrorInit['operation'];
  declare readonly operationId: string | null;
  declare readonly reservationId: string | null;
  declare readonly unavailableResponse: PylvaUnavailableResponseEvidence | null;
  declare readonly status: number | null;

  constructor(init: PylvaControlUnavailableErrorInit) {
    super(`[pylva] authoritative budget control unavailable (reason=${init.reason})`);
    this.name = 'PylvaControlUnavailableError';
    this.reason = init.reason;
    this.retryable = init.retryable;
    this.operation = init.operation;
    this.operationId = init.operationId ?? null;
    this.reservationId = init.reservationId ?? null;
    this.unavailableResponse = init.unavailableResponse ?? null;
    this.status = init.status ?? null;
  }
} as PylvaControlUnavailableErrorConstructor;
Object.defineProperty(PylvaControlUnavailableError, 'name', {
  value: 'PylvaControlUnavailableError',
});

export const PylvaControlApiError = class PylvaControlApiError
  extends Error
  implements PylvaControlApiError
{
  declare readonly status: number;
  declare readonly code: string;
  declare readonly param: string | null;

  constructor(status: number, code: string, param: string | null = null) {
    super(
      `[pylva] authoritative budget control rejected the request (HTTP ${status}, code=${code})`,
    );
    this.name = 'PylvaControlApiError';
    this.status = status;
    this.code = code;
    this.param = param;
  }
} as PylvaControlApiErrorConstructor;
Object.defineProperty(PylvaControlApiError, 'name', { value: 'PylvaControlApiError' });

export const PylvaControlValidationError = class PylvaControlValidationError
  extends TypeError
  implements PylvaControlValidationError
{
  declare readonly operation: string;

  constructor(operation: string) {
    super(`[pylva] ${operation} received an invalid authoritative-control value`);
    this.name = 'PylvaControlValidationError';
    this.operation = operation;
  }
} as PylvaControlValidationErrorConstructor;
Object.defineProperty(PylvaControlValidationError, 'name', {
  value: 'PylvaControlValidationError',
});
