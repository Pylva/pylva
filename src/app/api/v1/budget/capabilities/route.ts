import type { NextRequest } from 'next/server.js';
import { env } from '../../../../../lib/config.js';
import {
  createBudgetControlHttpHandler,
  type BudgetControlHttpDependencies,
  type BudgetControlServiceContext,
} from '../../../../../lib/budget-control/http-handler.js';
import { isBudgetExactBackfillAdapterConfigured } from '../../../../../lib/budget-control/exact-backfill-adapter.js';
import { toNextResponse } from '../../../../../lib/public-http/response.js';
import {
  readAuthenticatedBudgetControlRouteContext,
  sanitizedBudgetControlInternalResponse,
} from '../../../../../lib/budget-control/authenticated-next-route.js';

export interface CapabilitiesDependencies {
  featureEnabled?: () => boolean;
  exactBackfillConfigured?: () => boolean | Promise<boolean>;
  isBuilderReady?: (context: BudgetControlServiceContext) => boolean | Promise<boolean>;
  now?: BudgetControlHttpDependencies['now'];
}

async function defaultBuilderReadiness(
  context: BudgetControlServiceContext,
  exactBackfillConfigured: () => boolean | Promise<boolean>,
): Promise<boolean> {
  const { getBudgetControlProductionPosture } =
    await import('../../../../../lib/budget-control/runtime-posture.js');
  const posture = await getBudgetControlProductionPosture();
  if (!posture.ready) return false;

  const { getBudgetControlReadiness } =
    await import('../../../../../lib/budget-control/readiness.js');
  const readiness = await getBudgetControlReadiness(context.builderId);
  if (!readiness.ready) return false;
  return readiness.mode === 'next_period' || (await exactBackfillConfigured());
}

export function createGET(dependencies: CapabilitiesDependencies = {}) {
  const featureEnabled =
    dependencies.featureEnabled ?? (() => env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL);
  const exactBackfillConfigured =
    dependencies.exactBackfillConfigured ?? isBudgetExactBackfillAdapterConfigured;
  const isBuilderReady =
    dependencies.isBuilderReady ??
    ((context) => defaultBuilderReadiness(context, exactBackfillConfigured));
  const handler = createBudgetControlHttpHandler({
    now: dependencies.now,
    controlEnabled: async (context) => featureEnabled() && (await isBuilderReady(context)),
  });

  return async function GET(request: NextRequest): Promise<Response> {
    try {
      const authenticated = readAuthenticatedBudgetControlRouteContext(request);
      if (!authenticated.success) return authenticated.response;

      return toNextResponse(await handler.capabilities(authenticated.context));
    } catch {
      return sanitizedBudgetControlInternalResponse();
    }
  };
}

export const GET = createGET();
