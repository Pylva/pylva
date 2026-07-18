import type { BudgetAccountState, BudgetActivity } from '@/lib/budget-activity/types';
import { formatRelative, formatTelemetryUsd } from '@/lib/formatting';
import { BudgetStatusBadge } from './BudgetStatusBadge';

export function BudgetActivityPanel({
  activities,
  accounts,
  slug,
  title = 'Budget control',
}: {
  activities: BudgetActivity[];
  accounts: BudgetAccountState[];
  slug: string;
  title?: string;
}) {
  if (activities.length === 0 && accounts.length === 0) return null;
  return (
    <section className="mt-10" aria-labelledby="budget-control-heading">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[color:var(--primary)]">
            PostgreSQL authority
          </div>
          <h2 id="budget-control-heading" className="mt-1 text-lg font-semibold tracking-tight">
            {title}
          </h2>
        </div>
        <a
          href={`/o/${slug}/dashboard/budget-activity`}
          className="text-xs font-medium text-[color:var(--primary)] hover:underline"
        >
          Open all activity
        </a>
      </div>

      {accounts.length > 0 ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {accounts.map((account) => (
            <article
              key={account.account_id}
              className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {account.rule_name ?? account.rule_key}
                  </div>
                  <div className="mt-0.5 text-xs text-[color:var(--muted-foreground)]">
                    {account.period} · {account.scope.replace('_', ' ')}
                  </div>
                </div>
                <span className="shrink-0 text-xs font-medium">
                  {account.is_current ? '● Current' : '○ Closed'}
                </span>
              </div>
              <div className="mt-4 text-2xl font-semibold tabular-nums">
                {formatTelemetryUsd(account.available_usd)}
              </div>
              <div className="text-xs text-[color:var(--muted-foreground)]">
                available of {formatTelemetryUsd(account.limit_usd)}
              </div>
              <dl className="mt-3 grid grid-cols-3 gap-2 text-xs tabular-nums">
                <AccountDatum label="Charged" value={account.committed_usd} />
                <AccountDatum label="Reserved" value={account.reserved_usd} />
                <AccountDatum label="Unresolved" value={account.unresolved_usd} />
              </dl>
            </article>
          ))}
        </div>
      ) : null}

      {activities.length > 0 ? (
        <ul className="mt-4 divide-y divide-[color:var(--border)] rounded-lg border border-[color:var(--border)] bg-[color:var(--card)]">
          {activities.map((activity) => {
            const allocation =
              activity.allocations.find((item) => item.is_deciding) ?? activity.allocations[0];
            return (
              <li key={activity.decision_id} className="p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <BudgetStatusBadge status={activity.status} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{activity.source}</div>
                    <div className="mt-1 text-xs text-[color:var(--muted-foreground)]">
                      {activity.step_name ?? '(unnamed step)'} ·{' '}
                      {formatRelative(activity.activity_at)}
                    </div>
                  </div>
                  <div className="text-right text-sm font-medium tabular-nums">
                    {formatTelemetryUsd(
                      activity.status === 'charged'
                        ? activity.actual_usd
                        : (activity.requested_usd ?? '0'),
                    )}
                    <div className="text-xs font-normal text-[color:var(--muted-foreground)]">
                      {activity.provider_request === 'not_sent'
                        ? '⊘ provider not sent'
                        : activity.provider_request === 'sent'
                          ? '✓ provider sent'
                          : '… dispatch not confirmed'}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[color:var(--muted-foreground)]">
                  {allocation ? (
                    <span>
                      {allocation.rule_name ?? allocation.rule_key} · {allocation.period} ·
                      remaining {formatTelemetryUsd(allocation.remaining_usd)}
                    </span>
                  ) : null}
                  <a
                    href={`/o/${slug}/dashboard/traces/${activity.trace_id}`}
                    className="font-mono text-[color:var(--primary)] hover:underline"
                  >
                    trace {activity.trace_id.slice(0, 8)}…
                  </a>
                  <span>{activity.reason.replaceAll('_', ' ')}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function AccountDatum({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wider text-[color:var(--muted-foreground)]">
        {label}
      </dt>
      <dd className="mt-0.5 font-medium">{formatTelemetryUsd(value)}</dd>
    </div>
  );
}
