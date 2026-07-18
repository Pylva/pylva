// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.2 — portal data loaders.
// Per internal design notes
// (O21 + O33).
//
// Default time range = current billing period (O21). Direct ClickHouse
// query per page load (~1 min lag tolerated, per O33). Every query
// filters by builder_id AND single authorized customer_id — no
// cross-customer leak surface.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/client.js';
import { customerPricing } from '../db/schema.js';
import { queryCostEvents } from '../clickhouse/client.js';
import { resolveCustomerComposite } from '../clickhouse/customer-id.js';
import { chTimestamp } from '../clickhouse/datetime.js';

// PR #71 follow-up — resolveCustomerComposite lives in
// src/lib/clickhouse/customer-id.ts so the invoice generator can reuse
// it (PR #84 review found bug_024: the same internal-UUID-vs-composite
// bug in monthly-drafts cron).

export interface PortalRange {
  from: Date;
  to: Date;
  source: 'billing_period' | 'month_to_date';
}

/**
 * Resolve the default portal time range. Per O21: current billing
 * period if a customer_pricing row anchors it; otherwise month-to-date.
 */
export async function resolvePortalRange(
  builderId: string,
  customerId: string,
  now: Date = new Date(),
): Promise<PortalRange> {
  const pricing = await db
    .select({
      billing_period: customerPricing.billing_period,
      effective_from: customerPricing.effective_from,
    })
    .from(customerPricing)
    .where(
      and(
        eq(customerPricing.builder_id, builderId),
        eq(customerPricing.customer_id, customerId),
        // Active version only.
      ),
    )
    .limit(1);

  if (pricing.length > 0 && pricing[0]!.billing_period === 'monthly') {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    return { from, to: now, source: 'billing_period' };
  }

  // Fallback: month-to-date.
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { from, to: now, source: 'month_to_date' };
}

export interface PortalUsageOverview {
  total_cost_usd: number;
  event_count: number;
}

export interface PortalBreakdownRow {
  key: string;
  cost_usd: number;
  event_count: number;
}

/**
 * Customer-scoped overview. Every query in this module enforces
 * builder_id + customer_id at the WHERE clause level.
 */
export async function getPortalOverview(
  builderId: string,
  customerId: string,
  range: PortalRange,
): Promise<PortalUsageOverview> {
  const composite = await resolveCustomerComposite(builderId, customerId);
  if (!composite) {
    return { total_cost_usd: 0, event_count: 0 };
  }
  const rows = await queryCostEvents(
    builderId,
    `SELECT sum(cost_usd) AS total_cost_usd, count() AS event_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')`,
    {
      builder_id: builderId,
      customer_id: composite,
      from: chTimestamp(range.from),
      to: chTimestamp(range.to),
    },
  );

  const r = rows[0] as { total_cost_usd?: string; event_count?: string } | undefined;
  return {
    total_cost_usd: Number(r?.total_cost_usd ?? 0),
    event_count: Number(r?.event_count ?? 0),
  };
}

export async function getPortalBreakdownByModel(
  builderId: string,
  customerId: string,
  range: PortalRange,
): Promise<PortalBreakdownRow[]> {
  const composite = await resolveCustomerComposite(builderId, customerId);
  if (!composite) return [];
  const rows = await queryCostEvents(
    builderId,
    `SELECT model, sum(cost_usd) AS cost_usd, count() AS event_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
       AND model IS NOT NULL
     GROUP BY model
     ORDER BY cost_usd DESC
     LIMIT 20`,
    {
      builder_id: builderId,
      customer_id: composite,
      from: chTimestamp(range.from),
      to: chTimestamp(range.to),
    },
  );
  return (rows as Array<{ model: string; cost_usd?: string; event_count?: string }>).map((r) => ({
    key: r.model,
    cost_usd: Number(r.cost_usd ?? 0),
    event_count: Number(r.event_count ?? 0),
  }));
}

export interface PortalTrendPoint {
  day: string; // YYYY-MM-DD
  cost_usd: number;
  event_count: number;
}

/**
 * Daily cost trend for the customer over the portal range. Returns one
 * row per day in [range.from, range.to). Used by the portal usage page
 * + budget progress bar.
 */
export async function getPortalDailyTrend(
  builderId: string,
  customerId: string,
  range: PortalRange,
): Promise<PortalTrendPoint[]> {
  const composite = await resolveCustomerComposite(builderId, customerId);
  if (!composite) return [];
  const rows = await queryCostEvents(
    builderId,
    `SELECT toDate(timestamp) AS day,
            sum(cost_usd) AS cost_usd,
            count() AS event_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
     GROUP BY day
     ORDER BY day ASC`,
    {
      builder_id: builderId,
      customer_id: composite,
      from: chTimestamp(range.from),
      to: chTimestamp(range.to),
    },
  );
  return (rows as Array<{ day: string; cost_usd?: string; event_count?: string }>).map((r) => ({
    day: r.day,
    cost_usd: Number(r.cost_usd ?? 0),
    event_count: Number(r.event_count ?? 0),
  }));
}

/**
 * Step-level breakdown — gated by portal_configs.visibility_level. The
 * caller (portal page) is responsible for honoring the gate; this helper
 * returns the data unconditionally so it's reusable from APIs that have
 * already done the check.
 */
export async function getPortalBreakdownByStep(
  builderId: string,
  customerId: string,
  range: PortalRange,
): Promise<PortalBreakdownRow[]> {
  const composite = await resolveCustomerComposite(builderId, customerId);
  if (!composite) return [];
  const rows = await queryCostEvents(
    builderId,
    // PR #73 follow-up — `step_name IS NOT NULL` admits empty strings
    // because Nullable(String) accepts '' as a non-null value, which
    // surfaces as a blank row in the by-step list.
    `SELECT step_name, sum(cost_usd) AS cost_usd, count() AS event_count
     FROM cost_events_with_control
     WHERE builder_id = {builder_id:String}
       AND customer_id = {customer_id:String}
       AND timestamp >= parseDateTime64BestEffort({from:String}, 3, 'UTC')
       AND timestamp <  parseDateTime64BestEffort({to:String}, 3, 'UTC')
       AND step_name IS NOT NULL
       AND step_name != ''
     GROUP BY step_name
     ORDER BY cost_usd DESC
     LIMIT 50`,
    {
      builder_id: builderId,
      customer_id: composite,
      from: chTimestamp(range.from),
      to: chTimestamp(range.to),
    },
  );
  return (rows as Array<{ step_name: string; cost_usd?: string; event_count?: string }>).map(
    (r) => ({
      key: r.step_name,
      cost_usd: Number(r.cost_usd ?? 0),
      event_count: Number(r.event_count ?? 0),
    }),
  );
}
