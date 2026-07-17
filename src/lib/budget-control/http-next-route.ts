import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContext } from '../auth/builder-context.js';
import {
  createBudgetControlHttpHandler,
  defaultBudgetControlServiceAdapter,
  readBoundedBudgetControlBody,
  type BudgetControlServiceContext,
  type CommitBudgetUsageService,
  type ExtendBudgetUsageService,
  type ReleaseBudgetUsageService,
  type ReserveBudgetUsageService,
} from './http-handler.js';
import { readBudgetControlSdkIdentity } from './sdk-identity.js';
import { internalErrorResponse, toNextResponse, withNoStore } from '../public-http/response.js';

export type BudgetControlLifecycleRouteContext = { params: Promise<{ id: string }> };

type AuthenticatedRouteContext =
  | { success: true; context: BudgetControlServiceContext }
  | { success: false; response: Response };

function sanitizedInternalResponse(): Response {
  return toNextResponse(withNoStore(internalErrorResponse()));
}

function readAuthenticatedRouteContext(request: NextRequest): AuthenticatedRouteContext {
  const context = readBuilderContext(request);
  if (context instanceof NextResponse) {
    // Missing trusted headers indicate a deployment/middleware fault. Do not
    // expose the internal header contract in the public response.
    return { success: false, response: sanitizedInternalResponse() };
  }
  return {
    success: true,
    context: {
      ...context,
      sdkIdentity: readBudgetControlSdkIdentity(request.headers),
    },
  };
}

export function createReserveBudgetControlPOST(
  reserveBudgetUsage: ReserveBudgetUsageService = defaultBudgetControlServiceAdapter.reserveBudgetUsage,
) {
  const handler = createBudgetControlHttpHandler({
    services: { ...defaultBudgetControlServiceAdapter, reserveBudgetUsage },
  });

  return async function POST(request: NextRequest): Promise<Response> {
    try {
      const authenticated = readAuthenticatedRouteContext(request);
      if (!authenticated.success) return authenticated.response;
      const body = await readBoundedBudgetControlBody(request);
      if (!body.success) return toNextResponse(body.response);
      return toNextResponse(
        await handler.reserve({
          context: authenticated.context,
          rawBody: body.rawBody,
        }),
      );
    } catch {
      return sanitizedInternalResponse();
    }
  };
}

export function createCommitBudgetControlPOST(
  commitBudgetUsage: CommitBudgetUsageService = defaultBudgetControlServiceAdapter.commitBudgetUsage,
) {
  const handler = createBudgetControlHttpHandler({
    services: { ...defaultBudgetControlServiceAdapter, commitBudgetUsage },
  });

  return async function POST(
    request: NextRequest,
    route: BudgetControlLifecycleRouteContext,
  ): Promise<Response> {
    try {
      const authenticated = readAuthenticatedRouteContext(request);
      if (!authenticated.success) return authenticated.response;
      const { id } = await route.params;
      const body = await readBoundedBudgetControlBody(request);
      if (!body.success) return toNextResponse(body.response);
      return toNextResponse(
        await handler.commit({
          context: authenticated.context,
          reservationId: id,
          rawBody: body.rawBody,
        }),
      );
    } catch {
      return sanitizedInternalResponse();
    }
  };
}

export function createReleaseBudgetControlPOST(
  releaseBudgetUsage: ReleaseBudgetUsageService = defaultBudgetControlServiceAdapter.releaseBudgetUsage,
) {
  const handler = createBudgetControlHttpHandler({
    services: { ...defaultBudgetControlServiceAdapter, releaseBudgetUsage },
  });

  return async function POST(
    request: NextRequest,
    route: BudgetControlLifecycleRouteContext,
  ): Promise<Response> {
    try {
      const authenticated = readAuthenticatedRouteContext(request);
      if (!authenticated.success) return authenticated.response;
      const { id } = await route.params;
      const body = await readBoundedBudgetControlBody(request);
      if (!body.success) return toNextResponse(body.response);
      return toNextResponse(
        await handler.release({
          context: authenticated.context,
          reservationId: id,
          rawBody: body.rawBody,
        }),
      );
    } catch {
      return sanitizedInternalResponse();
    }
  };
}

export function createExtendBudgetControlPOST(
  extendBudgetUsage: ExtendBudgetUsageService = defaultBudgetControlServiceAdapter.extendBudgetUsage,
) {
  const handler = createBudgetControlHttpHandler({
    services: { ...defaultBudgetControlServiceAdapter, extendBudgetUsage },
  });

  return async function POST(
    request: NextRequest,
    route: BudgetControlLifecycleRouteContext,
  ): Promise<Response> {
    try {
      const authenticated = readAuthenticatedRouteContext(request);
      if (!authenticated.success) return authenticated.response;
      const { id } = await route.params;
      const body = await readBoundedBudgetControlBody(request);
      if (!body.success) return toNextResponse(body.response);
      return toNextResponse(
        await handler.extend({
          context: authenticated.context,
          reservationId: id,
          rawBody: body.rawBody,
        }),
      );
    } catch {
      return sanitizedInternalResponse();
    }
  };
}
