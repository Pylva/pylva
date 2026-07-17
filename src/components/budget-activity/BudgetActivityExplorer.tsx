'use client';

import { useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/lib/dashboard/api-client';
import { formatRelative, formatTelemetryUsd } from '@/lib/formatting';
import {
  budgetActivityQueryToSearchParams,
  parseBudgetActivityQuery,
} from '@/lib/budget-activity/query';
import type {
  BudgetActivity,
  BudgetActivityAllocation,
  BudgetActivityPage,
  BudgetActivityQuery,
} from '@/lib/budget-activity/types';
import { BudgetStatusBadge } from './BudgetStatusBadge';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ApiErrorBody {
  error?: { message?: string };
}

export function BudgetActivityExplorer({
  initial,
  initialError = null,
}: {
  initial: BudgetActivityPage;
  initialError?: string | null;
}) {
  const [data, setData] = useState(initial);
  const [query, setQuery] = useState(initial.filters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const abortRef = useRef<AbortController | null>(null);

  const hasActiveFilters = useMemo(
    () =>
      query.status !== 'all' ||
      query.kind !== 'all' ||
      query.customer !== null ||
      query.source !== null ||
      query.trace_id !== null ||
      query.rule_key !== null,
    [query],
  );

  async function load(nextQuery: BudgetActivityQuery): Promise<void> {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    const params = budgetActivityQueryToSearchParams(nextQuery);
    try {
      const response = await apiFetch(`/api/v1/budget-activity?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
        throw new Error(
          body?.error?.message ?? `Budget activity request failed (${response.status})`,
        );
      }
      const next = (await response.json()) as BudgetActivityPage;
      setData(next);
      setQuery(next.filters);
      const pageUrl = new URL(window.location.href);
      pageUrl.search = params.toString();
      window.history.replaceState(null, '', pageUrl);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      setError(caught instanceof Error ? caught.message : 'Budget activity is unavailable');
    } finally {
      if (abortRef.current === controller) setLoading(false);
    }
  }

  function submitFilters(formData: FormData): void {
    const params = new URLSearchParams();
    for (const key of ['status', 'kind', 'customer', 'source', 'trace_id', 'rule_key']) {
      const raw = formData.get(key);
      if (typeof raw === 'string' && raw.trim().length > 0) params.set(key, raw.trim());
    }
    params.set('page_size', String(query.page_size));
    try {
      void load(parseBudgetActivityQuery(params));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Invalid filters');
    }
  }

  function clearFilters(): void {
    const params = new URLSearchParams({ page_size: String(query.page_size) });
    void load(parseBudgetActivityQuery(params));
  }

  return (
    <div className="mt-7">
      <form
        key={budgetActivityQueryToSearchParams(query).toString()}
        className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4"
        action={submitFilters}
        aria-label="Budget activity filters"
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect label="Status" name="status" defaultValue={query.status}>
            <option value="all">All actions</option>
            <option value="reserved">Reserved</option>
            <option value="charged">Charged</option>
            <option value="released">Released</option>
            <option value="unresolved">Unresolved</option>
            <option value="refused">Refused</option>
          </FilterSelect>
          <FilterSelect label="Source kind" name="kind" defaultValue={query.kind}>
            <option value="all">LLMs and tools</option>
            <option value="llm">LLM only</option>
            <option value="tool">Tools only</option>
          </FilterSelect>
          <FilterInput label="End-user ID" name="customer" defaultValue={query.customer} />
          <FilterInput label="Provider, model, or tool" name="source" defaultValue={query.source} />
          <FilterInput label="Trace UUID" name="trace_id" defaultValue={query.trace_id} mono />
          <FilterInput label="Rule UUID" name="rule_key" defaultValue={query.rule_key} mono />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-[color:var(--primary)] px-3 py-1.5 text-sm font-medium text-[color:var(--primary-foreground)] disabled:opacity-50"
          >
            Apply filters
          </button>
          {hasActiveFilters ? (
            <button
              type="button"
              disabled={loading}
              onClick={clearFilters}
              className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm hover:bg-[color:var(--muted)] disabled:opacity-50"
            >
              Clear
            </button>
          ) : null}
          <span className="ml-auto text-xs text-[color:var(--muted-foreground)]">
            Authority: PostgreSQL · {data.pagination.total.toLocaleString()} actions
          </span>
        </div>
      </form>

      <div className="mt-4 min-h-24" aria-busy={loading} aria-live="polite">
        {loading ? <ActivityLoading /> : null}
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
          >
            <div className="font-medium">Budget activity could not be loaded.</div>
            <div className="mt-1">{error}</div>
            <button
              type="button"
              onClick={() => void load(query)}
              className="mt-3 rounded-md border border-current px-2.5 py-1 text-xs font-medium"
            >
              Try again
            </button>
          </div>
        ) : null}
        {!loading && !error && data.activities.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[color:var(--border)] p-10 text-center">
            <div className="text-sm font-medium">No control actions match these filters.</div>
            <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
              Reservations and refusals are control-only; they stay out of spend, event totals, and
              invoices.
            </p>
          </div>
        ) : null}
        {!loading && !error && data.activities.length > 0 ? (
          <>
            <DesktopActivityTable activities={data.activities} />
            <MobileActivityCards activities={data.activities} />
            <Pagination
              data={data}
              loading={loading}
              onPage={(page) => void load({ ...query, page })}
              onPageSize={(page_size) => void load({ ...query, page: 1, page_size })}
            />
          </>
        ) : null}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  name,
  defaultValue,
  children,
}: {
  label: string;
  name: string;
  defaultValue: string;
  children: React.ReactNode;
}) {
  return (
    <label className="text-xs font-medium text-[color:var(--muted-foreground)]">
      {label}
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 block h-9 w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-2 text-sm text-[color:var(--foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]"
      >
        {children}
      </select>
    </label>
  );
}

function FilterInput({
  label,
  name,
  defaultValue,
  mono = false,
}: {
  label: string;
  name: string;
  defaultValue: string | null;
  mono?: boolean;
}) {
  return (
    <label className="text-xs font-medium text-[color:var(--muted-foreground)]">
      {label}
      <input
        name={name}
        key={defaultValue ?? ''}
        defaultValue={defaultValue ?? ''}
        className={`mt-1 block h-9 w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-2 text-sm text-[color:var(--foreground)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)] ${mono ? 'font-mono' : ''}`}
      />
    </label>
  );
}

function ActivityLoading() {
  return (
    <div className="space-y-2" role="status">
      <span className="sr-only">Loading budget activity</span>
      {[0, 1, 2].map((index) => (
        <div
          key={index}
          className="h-16 animate-pulse rounded-md bg-[color:var(--muted)] motion-reduce:animate-none"
        />
      ))}
    </div>
  );
}

function primaryAllocation(activity: BudgetActivity) {
  return (
    activity.allocations.find((allocation) => allocation.is_deciding) ?? activity.allocations[0]
  );
}

function DesktopActivityTable({ activities }: { activities: BudgetActivity[] }) {
  return (
    <TableContainer className="hidden md:block">
      <Table className="min-w-[1120px]">
        <TableHeader>
          <TableRow>
            <TableHead>Action</TableHead>
            <TableHead>End-user / trace</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Budget proof</TableHead>
            <TableHead>Provider request</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {activities.map((activity) => {
            const allocation = primaryAllocation(activity);
            return (
              <TableRow key={activity.decision_id}>
                <TableCell className="align-top">
                  <BudgetStatusBadge status={activity.status} />
                  <div className="mt-2 text-xs text-[color:var(--muted-foreground)]">
                    {formatRelative(activity.activity_at)}
                  </div>
                </TableCell>
                <TableCell className="max-w-64 align-top">
                  <div className="font-medium">{activity.customer_id}</div>
                  <div className="mt-1 truncate font-mono text-xs text-[color:var(--muted-foreground)]">
                    {activity.trace_id}
                  </div>
                  <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">
                    {activity.step_name ?? '(unnamed step)'}
                  </div>
                </TableCell>
                <TableCell className="max-w-64 align-top">
                  <div className="font-medium">{activity.source}</div>
                  <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">
                    {activity.kind === 'llm' ? 'LLM' : 'Tool'} · {activity.framework}
                  </div>
                  {activity.maximum_value !== null ? (
                    <div className="mt-1 text-xs">Maximum usage: {activity.maximum_value}</div>
                  ) : null}
                </TableCell>
                <TableCell className="align-top">
                  <div className="font-medium tabular-nums">
                    {activity.status === 'charged'
                      ? formatTelemetryUsd(activity.actual_usd)
                      : formatTelemetryUsd(activity.requested_usd ?? '0')}
                  </div>
                  {allocation ? (
                    <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">
                      {allocation.rule_name ?? allocation.rule_key} · {allocation.period}
                      <br />
                      <AllocationBeforeSummary allocation={allocation} />
                      <br />
                      remaining {formatTelemetryUsd(allocation.remaining_usd)} of{' '}
                      {formatTelemetryUsd(allocation.limit_usd)}
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">
                      No applicable budget allocation
                    </div>
                  )}
                  <AllocationDetails activity={activity} />
                </TableCell>
                <TableCell className="align-top text-sm">
                  <ProviderRequest activity={activity} />
                  <div className="mt-2 max-w-56 text-xs text-[color:var(--muted-foreground)]">
                    {activity.reason.replaceAll('_', ' ')}
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function MobileActivityCards({ activities }: { activities: BudgetActivity[] }) {
  return (
    <ul className="space-y-3 md:hidden">
      {activities.map((activity) => {
        const allocation = primaryAllocation(activity);
        return (
          <li
            key={activity.decision_id}
            className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <BudgetStatusBadge status={activity.status} />
              <span className="text-xs text-[color:var(--muted-foreground)]">
                {formatRelative(activity.activity_at)}
              </span>
            </div>
            <div className="mt-3 font-medium">{activity.source}</div>
            <div className="mt-1 text-sm">{activity.customer_id}</div>
            <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">
              {activity.step_name ?? '(unnamed step)'}
            </div>
            <div className="mt-1 break-all font-mono text-xs text-[color:var(--muted-foreground)]">
              {activity.trace_id}
            </div>
            <dl
              className="mt-4 grid grid-cols-2 gap-3 text-xs"
              aria-label={`Budget proof for ${activity.source}`}
            >
              <MobileDatum
                label="Requested"
                value={formatTelemetryUsd(activity.requested_usd ?? '0')}
              />
              <MobileDatum label="Actual" value={formatTelemetryUsd(activity.actual_usd)} />
              {allocation ? (
                <>
                  <MobileDatum
                    label="Committed before"
                    value={formatTelemetryUsd(allocation.committed_before_usd)}
                  />
                  <MobileDatum
                    label="Reserved before"
                    value={formatTelemetryUsd(allocation.reserved_before_usd)}
                  />
                  <MobileDatum
                    label="Unresolved before"
                    value={formatTelemetryUsd(allocation.unresolved_before_usd)}
                  />
                </>
              ) : null}
              <MobileDatum
                label="Remaining"
                value={formatTelemetryUsd(
                  allocation?.remaining_usd ?? activity.remaining_usd ?? '0',
                )}
              />
              <MobileDatum label="Provider" value={providerRequestLabel(activity)} />
            </dl>
            <div className="mt-3 text-xs text-[color:var(--muted-foreground)]">
              {activity.reason.replaceAll('_', ' ')}
            </div>
            <AllocationDetails activity={activity} />
          </li>
        );
      })}
    </ul>
  );
}

function MobileDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="uppercase tracking-wider text-[color:var(--muted-foreground)]">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function AllocationBeforeSummary({ allocation }: { allocation: BudgetActivityAllocation }) {
  return (
    <>
      committed before {formatTelemetryUsd(allocation.committed_before_usd)} · reserved before{' '}
      {formatTelemetryUsd(allocation.reserved_before_usd)} · unresolved before{' '}
      {formatTelemetryUsd(allocation.unresolved_before_usd)}
    </>
  );
}

function AllocationDetails({ activity }: { activity: BudgetActivity }) {
  if (activity.allocations.length === 0) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer rounded-sm text-[color:var(--primary)] outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--ring)]">
        {activity.allocations.length === 1
          ? 'View rule proof'
          : `View ${activity.allocations.length} rule proofs`}
      </summary>
      <ul className="mt-2 space-y-2">
        {activity.allocations.map((allocation) => (
          <li key={allocation.rule_revision_id} className="rounded-md bg-[color:var(--muted)] p-2">
            <div className="font-medium">{allocation.rule_name ?? allocation.rule_key}</div>
            <div className="mt-1 font-mono text-[11px] text-[color:var(--muted-foreground)]">
              {allocation.rule_key} · revision {allocation.rule_revision}
            </div>
            <div className="mt-1">
              {allocation.scope.replace('_', ' ')} · {allocation.enforcement.replace('_', ' ')} ·{' '}
              {allocation.period} · {allocation.status.replace('_', ' ')}
            </div>
            <div className="mt-1 tabular-nums">
              requested {formatTelemetryUsd(allocation.requested_usd)} · projected{' '}
              {formatTelemetryUsd(allocation.projected_usd)} · limit{' '}
              {formatTelemetryUsd(allocation.limit_usd)}
            </div>
            <div className="mt-1 tabular-nums">
              <AllocationBeforeSummary allocation={allocation} />
            </div>
            <div className="mt-1 text-[color:var(--muted-foreground)]">
              Period {new Date(allocation.period_start).toLocaleString()} –{' '}
              {new Date(allocation.period_end).toLocaleString()}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

function providerRequestLabel(activity: BudgetActivity): string {
  if (activity.provider_request === 'not_sent') return '⊘ Not sent';
  if (activity.provider_request === 'sent') return '✓ Sent';
  return '… Not confirmed';
}

function ProviderRequest({ activity }: { activity: BudgetActivity }) {
  return (
    <span className="inline-flex items-center gap-1 font-medium">
      {providerRequestLabel(activity)}
    </span>
  );
}

function Pagination({
  data,
  loading,
  onPage,
  onPageSize,
}: {
  data: BudgetActivityPage;
  loading: boolean;
  onPage: (page: number) => void;
  onPageSize: (pageSize: number) => void;
}) {
  return (
    <nav className="mt-4 flex flex-wrap items-center gap-2" aria-label="Budget activity pages">
      <button
        type="button"
        disabled={loading || data.pagination.page <= 1}
        onClick={() => onPage(data.pagination.page - 1)}
        className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm hover:bg-[color:var(--muted)] disabled:opacity-40"
      >
        Previous
      </button>
      <span className="text-sm text-[color:var(--muted-foreground)]">
        Page {data.pagination.page} of {data.pagination.total_pages}
      </span>
      <button
        type="button"
        disabled={loading || data.pagination.page >= data.pagination.total_pages}
        onClick={() => onPage(data.pagination.page + 1)}
        className="rounded-md border border-[color:var(--border)] px-3 py-1.5 text-sm hover:bg-[color:var(--muted)] disabled:opacity-40"
      >
        Next
      </button>
      <label className="ml-auto text-xs text-[color:var(--muted-foreground)]">
        Rows
        <select
          value={data.pagination.page_size}
          onChange={(event) => onPageSize(Number(event.target.value))}
          className="ml-2 rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-2 py-1 text-sm text-[color:var(--foreground)]"
        >
          <option value="10">10</option>
          <option value="25">25</option>
          <option value="50">50</option>
          <option value="100">100</option>
        </select>
      </label>
    </nav>
  );
}
