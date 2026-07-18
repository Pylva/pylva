import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContext } from '../auth/builder-context.js';
import { internalErrorResponse, toNextResponse, withNoStore } from '../public-http/response.js';
import type { BudgetControlServiceContext } from './http-handler.js';
import { readBudgetControlSdkIdentity } from './sdk-identity.js';

export type AuthenticatedBudgetControlRouteContext =
  { success: true; context: BudgetControlServiceContext } | { success: false; response: Response };

/**
 * Return the one public response used when trusted middleware context is
 * absent or a Next route fails unexpectedly. The private header contract must
 * never become part of the SDK-facing error body.
 */
export function sanitizedBudgetControlInternalResponse(): Response {
  return toNextResponse(withNoStore(internalErrorResponse()));
}

/** Read middleware-authenticated SDK identity without exposing header names. */
export function readAuthenticatedBudgetControlRouteContext(
  request: NextRequest,
): AuthenticatedBudgetControlRouteContext {
  const context = readBuilderContext(request);
  if (context instanceof NextResponse) {
    return { success: false, response: sanitizedBudgetControlInternalResponse() };
  }
  return {
    success: true,
    context: {
      ...context,
      sdkIdentity: readBudgetControlSdkIdentity(request.headers),
    },
  };
}
