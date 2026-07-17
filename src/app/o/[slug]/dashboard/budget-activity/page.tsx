import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { BudgetActivityQueryError, parseBudgetActivityQuery } from '@/lib/budget-activity/query';
import { listBudgetActivity } from '@/lib/budget-activity/read-model';
import type { BudgetActivityPage } from '@/lib/budget-activity/types';
import { PageHeader } from '@/components/dashboard/PageHeader';
import { BudgetActivityExplorer } from '@/components/budget-activity/BudgetActivityExplorer';
import { logger } from '@/lib/logger';

export const metadata: Metadata = { title: 'Budget activity' };

const log = logger.child({ module: 'dashboard.budget_activity' });

function toUrlSearchParams(values: Record<string, string | string[] | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') params.set(key, value);
    else if (Array.isArray(value)) value.forEach((item) => params.append(key, item));
  }
  return params;
}

function emptyPage(filters: BudgetActivityPage['filters']): BudgetActivityPage {
  return {
    activities: [],
    pagination: { page: filters.page, page_size: filters.page_size, total: 0, total_pages: 0 },
    filters,
    authority: 'postgresql',
  };
}

export default async function BudgetActivityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ builderId }, rawSearchParams] = await Promise.all([
    readDashboardHeaders(),
    searchParams,
  ]);
  const fallbackQuery = parseBudgetActivityQuery(new URLSearchParams());
  let initial = emptyPage(fallbackQuery);
  let initialError: string | null = null;

  try {
    const query = parseBudgetActivityQuery(toUrlSearchParams(rawSearchParams));
    initial = await listBudgetActivity(builderId, query);
  } catch (error) {
    initialError =
      error instanceof BudgetActivityQueryError
        ? error.message
        : 'Budget activity is temporarily unavailable';
    if (!(error instanceof BudgetActivityQueryError)) {
      log.warn(
        { builder_id: builderId, error: error instanceof Error ? error.message : String(error) },
        'dashboard budget activity unavailable',
      );
    }
  }

  return (
    <>
      <PageHeader
        title="Budget activity"
        description="Every authorization, charge, release, unresolved hold, and refusal from the PostgreSQL control authority."
      />
      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-l-2 border-[color:var(--primary)] pl-3 text-xs text-[color:var(--muted-foreground)]">
        <span>Refused means the provider request was not sent.</span>
        <span>Only charged actions become spend or invoice events.</span>
      </div>
      <BudgetActivityExplorer initial={initial} initialError={initialError} />
    </>
  );
}
