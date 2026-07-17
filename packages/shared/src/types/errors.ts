// Stripe-style error types — Decision #17
// These are standalone, no imports from other type files

export type ErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'rate_limit_error'
  | 'api_error';

export const ErrorCode = {
  INVALID_API_KEY: 'INVALID_API_KEY',
  WRONG_SCOPE: 'WRONG_SCOPE',
  TIER_LIMIT_REACHED: 'TIER_LIMIT_REACHED',
  FEATURE_NOT_AVAILABLE: 'FEATURE_NOT_AVAILABLE',
  AUDIENCE_MISMATCH: 'AUDIENCE_MISMATCH',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  NOT_FOUND: 'NOT_FOUND',
  DUPLICATE_RESOURCE: 'DUPLICATE_RESOURCE',
  INSUFFICIENT_PERMISSIONS: 'INSUFFICIENT_PERMISSIONS',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RESERVATION_STATE_CONFLICT: 'RESERVATION_STATE_CONFLICT',
  /** A tenant dashboard request omitted or contradicted its page-bound context. */
  DASHBOARD_CONTEXT_REQUIRED: 'DASHBOARD_CONTEXT_REQUIRED',
  /** The browser session user no longer matches the user that rendered the page. */
  SESSION_MISMATCH: 'SESSION_MISMATCH',
  /** The browser session no longer belongs to the org the page was loaded for (account switched in another tab). */
  ORG_MISMATCH: 'ORG_MISMATCH',
  /** @deprecated No longer emitted: API key creation dropped the step-up email confirmation with the universal key. */
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ApiErrorResponse {
  error: {
    type: ErrorType;
    code: ErrorCode;
    message: string;
    param?: string;
  };
}

export function createApiError(
  type: ErrorType,
  code: ErrorCode,
  message: string,
  param?: string,
): ApiErrorResponse {
  return {
    error: {
      type,
      code,
      message,
      ...(param !== undefined && { param }),
    },
  };
}

export function createValidationError(message: string, param: string): ApiErrorResponse {
  return createApiError('invalid_request_error', ErrorCode.VALIDATION_ERROR, message, param);
}

export function createAuthError(code: ErrorCode, message: string): ApiErrorResponse {
  return createApiError('authentication_error', code, message);
}
