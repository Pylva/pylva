// Stripe-style error response utilities — Decision #17
// Uses types from @pylva/shared

import { NextResponse } from 'next/server.js';
import {
  type ErrorType,
  ErrorCode,
  type ApiErrorResponse,
  createApiError,
} from '@pylva/shared';

export function apiError(
  status: number,
  type: ErrorType,
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
  param?: string,
): NextResponse<ApiErrorResponse> {
  return NextResponse.json(createApiError(type, code, message, param), { status });
}

export function validationError(message: string, param: string): NextResponse<ApiErrorResponse> {
  return apiError(400, 'invalid_request_error', ErrorCode.VALIDATION_ERROR, message, param);
}

export function authError(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
): NextResponse<ApiErrorResponse> {
  return apiError(401, 'authentication_error', code, message);
}

export function forbiddenError(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
): NextResponse<ApiErrorResponse> {
  return apiError(403, 'invalid_request_error', code, message);
}

export function rateLimitError(retryAfterSeconds: number): NextResponse<ApiErrorResponse> {
  return NextResponse.json(
    createApiError(
      'rate_limit_error',
      ErrorCode.RATE_LIMIT_EXCEEDED,
      `Rate limit exceeded. Retry after ${retryAfterSeconds} seconds.`,
    ),
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    },
  );
}

export function internalError(
  message = 'An internal error occurred',
): NextResponse<ApiErrorResponse> {
  return apiError(500, 'api_error', ErrorCode.INTERNAL_ERROR, message);
}

export function notFoundError(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
): NextResponse<ApiErrorResponse> {
  return apiError(404, 'invalid_request_error', code, message);
}

export function goneError(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
): NextResponse<ApiErrorResponse> {
  return apiError(410, 'invalid_request_error', code, message);
}

// Extract first issue from a Valibot safeParse failure. Path items have
// `key: unknown` (maps can be keyed by anything); we narrow to string|number
// for the API `param` field and skip the rest.
export function valibotFirstIssue(
  issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<{ key: unknown }> }>,
): { message: string; param: string } {
  const first = issues[0];
  if (!first) return { message: 'Invalid request body', param: 'body' };
  const param = (first.path ?? [])
    .map((p) => (typeof p.key === 'string' || typeof p.key === 'number' ? String(p.key) : ''))
    .filter((s) => s.length > 0)
    .join('.');
  return { message: first.message, param: param || 'body' };
}
