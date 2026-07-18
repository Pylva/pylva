import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { apiError, validationError } from '@/lib/errors';
import { BudgetActivityQueryError, parseBudgetActivityQuery } from '@/lib/budget-activity/query';
import { listBudgetActivity } from '@/lib/budget-activity/read-model';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'api.budget_activity' });
const NO_STORE = 'private, no-store, max-age=0';

function noStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', NO_STORE);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = readBuilderContextFromDashboard(request);
  if (context instanceof NextResponse) return noStore(context);

  let query;
  try {
    query = parseBudgetActivityQuery(new URL(request.url).searchParams);
  } catch (error) {
    if (error instanceof BudgetActivityQueryError) {
      return noStore(validationError(error.message, error.param));
    }
    throw error;
  }

  try {
    const result = await listBudgetActivity(context.builderId, query);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': NO_STORE },
    });
  } catch (error) {
    log.warn(
      {
        builder_id: context.builderId,
        error: error instanceof Error ? error.message : String(error),
      },
      'authoritative budget activity unavailable',
    );
    return noStore(
      apiError(
        503,
        'api_error',
        ErrorCode.INTERNAL_ERROR,
        'Budget activity is temporarily unavailable',
      ),
    );
  }
}
