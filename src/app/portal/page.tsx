// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.3 — portal landing page.
//
// End-user lands here via the link the builder shared. Token comes via
// `?token=` query param (legacy direct link) or via the cookie if the
// session was already exchanged.
//
// Page is mobile-first per O30 (portal is mobile-first; builder
// dashboard is desktop-primary).
//
// Iframe support: this page is embeddable. CSP frame-ancestors header is
// set in middleware (PR 4.3) based on portal_configs.allowed_iframe_origins.

import type { Metadata } from 'next';
import { authenticatePortalToken } from '@/lib/portal/auth';
import { eq } from 'drizzle-orm';
import { VisibilityLevel } from '@pylva/shared';
import { withRLS } from '@/lib/db/rls';
import { portalConfigs } from '@/lib/db/schema';
import { checkPortalEntitlement } from '@/lib/portal/entitlement';
import {
  getPortalBreakdownByModel,
  getPortalBreakdownByStep,
  getPortalDailyTrend,
  getPortalOverview,
  resolvePortalRange,
  type PortalTrendPoint,
} from '@/lib/portal/data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Token-scoped customer data: never indexable, never link-harvested.
// Middleware also sets X-Robots-Tag for /portal at the HTTP layer.
export const metadata: Metadata = {
  title: 'Usage portal',
  robots: { index: false, follow: false },
};

export default async function PortalPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;
  if (!token)
    return (
      <PortalError
        title="Link required"
        body="This portal must be opened via a builder-issued link."
      />
    );

  const outcome = await authenticatePortalToken(token);
  if (outcome.kind === 'unauthenticated') {
    return (
      <PortalError
        title="Link is invalid"
        body="This portal link couldn’t be verified. Ask the builder for a fresh one."
      />
    );
  }
  if (outcome.kind === 'expired') {
    return (
      <PortalError
        title="Link expired"
        body="This portal link has expired. Ask the builder for a fresh one."
      />
    );
  }
  if (outcome.kind === 'rate_limited') {
    return <PortalError title="Too many requests" body="Slow down — please refresh in a minute." />;
  }

  const ctx = outcome.ctx;
  const entitlement = await checkPortalEntitlement(ctx.builderId);
  if (entitlement) {
    const body =
      entitlement.status === 403
        ? "This portal is not available on the builder's current plan."
        : 'This portal is currently unavailable.';

    return (
      <PortalError
        title="Portal unavailable"
        body={body}
      />
    );
  }

  const [config, range] = await Promise.all([
    withRLS(ctx.builderId, async (tx) =>
      tx.select().from(portalConfigs).where(eq(portalConfigs.builder_id, ctx.builderId)).limit(1),
    ),
    resolvePortalRange(ctx.builderId, ctx.customerId),
  ]);
  const cfgRow = config[0];
  const visibility = cfgRow?.visibility_level ?? VisibilityLevel.AGGREGATE_ONLY;
  const showTrend = cfgRow?.show_usage_trend ?? true;

  const [overview, byModel, byStep, trend] = await Promise.all([
    getPortalOverview(ctx.builderId, ctx.customerId, range),
    visibility === VisibilityLevel.AGGREGATE_ONLY
      ? Promise.resolve([])
      : getPortalBreakdownByModel(ctx.builderId, ctx.customerId, range),
    visibility === VisibilityLevel.STEP_LEVEL
      ? getPortalBreakdownByStep(ctx.builderId, ctx.customerId, range)
      : Promise.resolve([]),
    showTrend
      ? getPortalDailyTrend(ctx.builderId, ctx.customerId, range)
      : Promise.resolve([] as PortalTrendPoint[]),
  ]);

  const cfg = cfgRow;
  const company = cfg?.company_name ?? 'Usage';
  const logo = cfg?.logo_url ?? null;
  const primaryColor = cfg?.primary_color ?? '#4f46e5';

  const formatUsd = (n: number): string => `$${n.toFixed(2)}`;

  return (
    <main data-portal className="min-h-screen px-4 py-8 md:py-12">
      <div className="mx-auto w-full max-w-3xl">
        <header className="flex items-center gap-3">
          {logo ? <img src={logo} alt={company} className="h-8 w-8 rounded" /> : null}
          <h1 className="text-xl font-semibold">{company}</h1>
        </header>

        <section className="mt-8 rounded-xl border border-[color:var(--portal-line)] bg-[color:var(--portal-panel)] p-5">
          <div className="text-xs uppercase tracking-wider text-[color:var(--portal-muted)]">
            {range.source === 'billing_period' ? 'Current billing period' : 'Month to date'}
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <span className="text-3xl font-semibold" style={{ color: primaryColor }}>
              {formatUsd(overview.total_cost_usd)}
            </span>
            <span className="text-sm text-[color:var(--portal-muted)]">spent</span>
          </div>
          <div className="mt-1 text-sm text-[color:var(--portal-muted)]">
            {overview.event_count.toLocaleString()} events · since {range.from.toLocaleDateString()}
          </div>
        </section>

        {trend.length > 0 ? (
          <section className="mt-6 rounded-xl border border-[color:var(--portal-line)] bg-[color:var(--portal-panel)] p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--portal-muted)]">
              Daily trend
            </h2>
            <Sparkbars points={trend} primary={primaryColor} formatUsd={formatUsd} />
          </section>
        ) : null}

        {byModel.length > 0 ? (
          <section className="mt-6 rounded-xl border border-[color:var(--portal-line)] bg-[color:var(--portal-panel)] p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--portal-muted)]">
              By model
            </h2>
            <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
              {byModel.map((row) => (
                <li key={row.key} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate font-medium">{row.key}</span>
                  <span className="ml-3 shrink-0 tabular-nums text-[color:var(--portal-muted)]">
                    {formatUsd(row.cost_usd)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {byStep.length > 0 ? (
          <section className="mt-6 rounded-xl border border-[color:var(--portal-line)] bg-[color:var(--portal-panel)] p-5">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[color:var(--portal-muted)]">
              By step
            </h2>
            <ul className="mt-3 divide-y divide-zinc-100 dark:divide-zinc-800">
              {byStep.map((row) => (
                <li key={row.key} className="flex items-center justify-between py-2 text-sm">
                  <span className="truncate font-medium">{row.key}</span>
                  <span className="ml-3 shrink-0 tabular-nums text-[color:var(--portal-muted)]">
                    {formatUsd(row.cost_usd)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="mt-8 text-xs text-[color:var(--portal-muted)]">
          Powered by Pylva
          {' · '}
          <a href="/portal/refresh" className="underline">
            Refresh
          </a>
        </footer>
      </div>
    </main>
  );
}

function PortalError({ title, body }: { title: string; body: string }) {
  return (
    <main data-portal className="mx-auto min-h-screen w-full max-w-md px-4 py-16 text-center">
      <h1 className="text-xl font-semibold">{title}</h1>
      <p className="mt-2 text-sm text-[color:var(--portal-muted)]">{body}</p>
    </main>
  );
}

/**
 * Pure-CSS sparkbar chart — one bar per day, height = cost / max. No
 * client-side JS, no SVG dep. Tooltips via title attribute keep the
 * mobile-first contract: tap-and-hold reveals the per-day amount.
 */
function Sparkbars({
  points,
  primary,
  formatUsd,
}: {
  points: PortalTrendPoint[];
  primary: string;
  formatUsd: (n: number) => string;
}) {
  const max = Math.max(...points.map((p) => p.cost_usd), 0.0001);
  return (
    <div className="mt-3 flex h-24 items-end gap-1">
      {points.map((p) => {
        const pct = Math.max(2, Math.round((p.cost_usd / max) * 100));
        return (
          <div
            key={p.day}
            title={`${p.day} — ${formatUsd(p.cost_usd)} (${p.event_count} events)`}
            className="flex-1 rounded-sm"
            style={{
              height: `${pct}%`,
              backgroundColor: primary,
              opacity: p.cost_usd > 0 ? 0.85 : 0.25,
            }}
            aria-label={`${p.day} ${formatUsd(p.cost_usd)}`}
          />
        );
      })}
    </div>
  );
}
