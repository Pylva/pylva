import { createApiError, ErrorCode, type ApiErrorResponse, type ErrorType } from '@pylva/shared';

export interface PublicHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): PublicHttpResponse {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  };
}

export function textResponse(
  body: string,
  status = 200,
  headers: Record<string, string> = {},
): PublicHttpResponse {
  return {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', ...headers },
    body,
  };
}

export function emptyResponse(status = 200): PublicHttpResponse {
  return { status, body: '' };
}

export function apiErrorResponse(
  status: number,
  type: ErrorType,
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
  param?: string,
): PublicHttpResponse {
  const body: ApiErrorResponse = createApiError(type, code, message, param);
  return jsonResponse(body, status);
}

export function validationErrorResponse(message: string, param: string): PublicHttpResponse {
  return apiErrorResponse(400, 'invalid_request_error', ErrorCode.VALIDATION_ERROR, message, param);
}

export function authErrorResponse(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
): PublicHttpResponse {
  return apiErrorResponse(401, 'authentication_error', code, message);
}

export function forbiddenErrorResponse(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
): PublicHttpResponse {
  return apiErrorResponse(403, 'invalid_request_error', code, message);
}

export function rateLimitErrorResponse(retryAfterSeconds: number): PublicHttpResponse {
  const response = apiErrorResponse(
    429,
    'rate_limit_error',
    ErrorCode.RATE_LIMIT_EXCEEDED,
    `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    undefined,
  );
  response.headers = { ...response.headers, 'Retry-After': String(retryAfterSeconds) };
  return response;
}

export function internalErrorResponse(message = 'An internal error occurred'): PublicHttpResponse {
  return apiErrorResponse(500, 'api_error', ErrorCode.INTERNAL_ERROR, message);
}

export function serviceUnavailableErrorResponse(
  message = 'Budget control is temporarily unavailable',
): PublicHttpResponse {
  return apiErrorResponse(503, 'api_error', ErrorCode.INTERNAL_ERROR, message);
}

export function resourceNotFoundErrorResponse(
  message = 'Reservation not found',
): PublicHttpResponse {
  return apiErrorResponse(404, 'invalid_request_error', ErrorCode.RESOURCE_NOT_FOUND, message);
}

export function idempotencyConflictErrorResponse(
  message = 'operation_id was reused with a different request',
): PublicHttpResponse {
  return apiErrorResponse(409, 'invalid_request_error', ErrorCode.IDEMPOTENCY_CONFLICT, message);
}

export function reservationStateConflictErrorResponse(
  message = 'reservation state conflicts with this operation',
): PublicHttpResponse {
  return apiErrorResponse(
    409,
    'invalid_request_error',
    ErrorCode.RESERVATION_STATE_CONFLICT,
    message,
  );
}

/** Public control decisions and errors are live tenant state and never cacheable. */
export function withNoStore(response: PublicHttpResponse): PublicHttpResponse {
  response.headers = { ...response.headers, 'Cache-Control': 'no-store' };
  return response;
}

export function toNextResponse(response: PublicHttpResponse): Response {
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
}
