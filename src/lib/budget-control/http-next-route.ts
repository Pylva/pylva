import type { NextRequest } from 'next/server.js';
import {
  createBudgetControlHttpHandler,
  defaultBudgetControlServiceAdapter,
  readBoundedBudgetControlBody,
  type CommitBudgetUsageService,
  type ExtendBudgetUsageService,
  type ReleaseBudgetUsageService,
  type ReserveBudgetUsageService,
} from './http-handler.js';
import { toNextResponse } from '../public-http/response.js';
import {
  readAuthenticatedBudgetControlRouteContext,
  sanitizedBudgetControlInternalResponse,
} from './authenticated-next-route.js';

export type BudgetControlLifecycleRouteContext = { params: Promise<{ id: string }> };

export function createReserveBudgetControlPOST(
  reserveBudgetUsage: ReserveBudgetUsageService = defaultBudgetControlServiceAdapter.reserveBudgetUsage,
) {
  const handler = createBudgetControlHttpHandler({
    services: { ...defaultBudgetControlServiceAdapter, reserveBudgetUsage },
  });

  return async function POST(request: NextRequest): Promise<Response> {
    try {
      const authenticated = readAuthenticatedBudgetControlRouteContext(request);
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
      return sanitizedBudgetControlInternalResponse();
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
      const authenticated = readAuthenticatedBudgetControlRouteContext(request);
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
      return sanitizedBudgetControlInternalResponse();
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
      const authenticated = readAuthenticatedBudgetControlRouteContext(request);
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
      return sanitizedBudgetControlInternalResponse();
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
      const authenticated = readAuthenticatedBudgetControlRouteContext(request);
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
      return sanitizedBudgetControlInternalResponse();
    }
  };
}
