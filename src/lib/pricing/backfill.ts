// Hourly backfill of cost_usd for events marked pricing_status='needs_input'
// or 'pending'. For each (builder_id, provider, model) or (builder_id, metric)
// combo that is now priced, compute cost_usd, issue a ClickHouse
// ALTER TABLE … UPDATE, and close the matching pricing_onboarding_tasks row.

import { type SQL, sql as drizzleSql } from 'drizzle-orm';
import { clickhouse } from '../clickhouse/client.js';
import { withRLS } from '../db/rls.js';
import { unwrapRows } from '../db/query-utils.js';
import { auditLog } from '../auth/audit-log.js';
import { AuditAction } from '../audit/actions.js';
import { MAX_STORABLE_COST_USD } from '../clickhouse/decimal-limits.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'pricing.backfill' });

const MAX_GROUPS_PER_RUN = 500; // re-run the cron to drain a backlog
const METRIC_COST_EXPR = 'metric_value * {ppuUsd:Float64}';
const LLM_COST_EXPR = '(tokens_in * {inUsd:Float64} + tokens_out * {outUsd:Float64}) / 1000000';

interface PendingGroup {
  builder_id: string;
  provider: string | null;
  model: string | null;
  metric: string | null;
  min_ts: string;
  max_ts: string;
}

interface PriceWindow {
  effective_from: Date | string;
  effective_to: Date | string | null;
}

interface LlmPriceWindow extends PriceWindow {
  input_per_1m: number;
  output_per_1m: number;
}

interface MetricPriceWindow extends PriceWindow {
  price_per_unit_usd: number;
}

async function getPendingGroups(): Promise<PendingGroup[]> {
  const result = await clickhouse.query({
    query: `
      SELECT builder_id,
             provider,
             model,
             metric,
             min(timestamp) AS min_ts,
             max(timestamp) AS max_ts
      FROM cost_events
      WHERE pricing_status IN ('needs_input', 'pending')
      GROUP BY builder_id, provider, model, metric
      LIMIT ${MAX_GROUPS_PER_RUN}
    `,
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    builder_id: String(r['builder_id']),
    provider: r['provider'] == null ? null : String(r['provider']),
    model: r['model'] == null ? null : String(r['model']),
    metric: r['metric'] == null ? null : String(r['metric']),
    min_ts: String(r['min_ts']),
    max_ts: String(r['max_ts']),
  }));
}

function asIso(value: Date | string): string {
  return new Date(value).toISOString();
}

function subtractPriceWindows<T extends PriceWindow>(windows: T[], blockers: PriceWindow[]): T[] {
  return blockers.reduce<T[]>((fragments, blocker) => {
    const blockerStart = new Date(blocker.effective_from).getTime();
    const blockerEnd = blocker.effective_to
      ? new Date(blocker.effective_to).getTime()
      : Number.POSITIVE_INFINITY;

    return fragments.flatMap((fragment) => {
      const fragmentStart = new Date(fragment.effective_from).getTime();
      const fragmentEnd = fragment.effective_to
        ? new Date(fragment.effective_to).getTime()
        : Number.POSITIVE_INFINITY;
      if (blockerEnd <= fragmentStart || blockerStart >= fragmentEnd) return [fragment];

      const remainder: T[] = [];
      if (blockerStart > fragmentStart) {
        remainder.push({
          ...fragment,
          effective_to: new Date(Math.min(blockerStart, fragmentEnd)),
        });
      }
      if (blockerEnd < fragmentEnd) {
        remainder.push({
          ...fragment,
          effective_from: new Date(Math.max(blockerEnd, fragmentStart)),
        });
      }
      return remainder;
    });
  }, windows);
}

async function findLlmPrices(
  builderId: string,
  provider: string,
  model: string,
  fromIso: string,
  toIso: string,
): Promise<LlmPriceWindow[]> {
  return await withRLS(builderId, async (tx) => {
    const customResult = await tx.execute<{
      input_per_1m_usd: string | null;
      output_per_1m_usd: string | null;
      price_per_unit_usd: string | null;
      effective_from: Date | string;
      effective_to: Date | string | null;
    }>(drizzleSql`
      SELECT input_per_1m_usd::text AS input_per_1m_usd,
             output_per_1m_usd::text AS output_per_1m_usd,
             price_per_unit_usd::text AS price_per_unit_usd,
             effective_from, effective_to
      FROM custom_pricing
      WHERE builder_id = ${builderId}::uuid
        AND provider = ${provider} AND model = ${model}
        AND effective_from <= ${toIso}::timestamptz
        AND (effective_to IS NULL OR effective_to > ${fromIso}::timestamptz)
      ORDER BY effective_from
    `);
    const customRows = unwrapRows<{
      input_per_1m_usd: string | null;
      output_per_1m_usd: string | null;
      price_per_unit_usd: string | null;
      effective_from: Date | string;
      effective_to: Date | string | null;
    }>(customResult).map((row) => {
      const pppu = row.price_per_unit_usd;
      return {
        input_per_1m:
          row.input_per_1m_usd != null
            ? Number(row.input_per_1m_usd)
            : pppu != null
              ? Number(pppu) * 1_000_000
              : 0,
        output_per_1m:
          row.output_per_1m_usd != null
            ? Number(row.output_per_1m_usd)
            : pppu != null
              ? Number(pppu) * 1_000_000
              : 0,
        effective_from: row.effective_from,
        effective_to: row.effective_to,
      };
    });

    const globalResult = await tx.execute<{
      input_per_1m: string;
      output_per_1m: string;
      effective_from: Date | string;
      effective_to: Date | string | null;
    }>(drizzleSql`
      SELECT input_per_1m::text AS input_per_1m,
             output_per_1m::text AS output_per_1m,
             effective_from, effective_to
      FROM llm_pricing
      WHERE provider = ${provider} AND model = ${model}
        AND effective_from <= ${toIso}::timestamptz
        AND (effective_to IS NULL OR effective_to > ${fromIso}::timestamptz)
      ORDER BY effective_from
    `);
    const globalRows = unwrapRows<{
      input_per_1m: string;
      output_per_1m: string;
      effective_from: Date | string;
      effective_to: Date | string | null;
    }>(globalResult).map((row) => ({
      input_per_1m: Number(row.input_per_1m ?? 0),
      output_per_1m: Number(row.output_per_1m ?? 0),
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    }));

    // Custom prices must run first and global prices may only fill time ranges
    // not covered by a custom row. Subtract the custom intervals explicitly:
    // relying only on `pricing_status='pending'` would let a global price take
    // over when the custom calculation is out of the storable Decimal range.
    return [...customRows, ...subtractPriceWindows(globalRows, customRows)];
  });
}

async function findMetricPrices(
  builderId: string,
  metric: string,
  fromIso: string,
  toIso: string,
): Promise<MetricPriceWindow[]> {
  return await withRLS(builderId, async (tx) => {
    const result = await tx.execute<{
      price_per_unit_usd: string;
      effective_from: Date | string;
      effective_to: Date | string | null;
    }>(drizzleSql`
      SELECT price_per_unit_usd::text AS price_per_unit_usd,
             effective_from, effective_to
      FROM custom_pricing
      WHERE builder_id = ${builderId}::uuid
        AND metric = ${metric}
        AND effective_from <= ${toIso}::timestamptz
        AND (effective_to IS NULL OR effective_to > ${fromIso}::timestamptz)
      ORDER BY effective_from
    `);
    return unwrapRows<{
      price_per_unit_usd: string;
      effective_from: Date | string;
      effective_to: Date | string | null;
    }>(result).map((row) => ({
      price_per_unit_usd: Number(row.price_per_unit_usd),
      effective_from: row.effective_from,
      effective_to: row.effective_to,
    }));
  });
}

function priceWindowClause(window: PriceWindow): string {
  return window.effective_to == null
    ? 'AND timestamp >= parseDateTimeBestEffort({priceFrom:String})'
    : `AND timestamp >= parseDateTimeBestEffort({priceFrom:String})
             AND timestamp < parseDateTimeBestEffort({priceTo:String})`;
}

function priceWindowParams(window: PriceWindow): { priceFrom: string; priceTo?: string } {
  return {
    priceFrom: asIso(window.effective_from),
    ...(window.effective_to == null ? {} : { priceTo: asIso(window.effective_to) }),
  };
}

async function hasRemainingMetricPending(builderId: string, metric: string): Promise<boolean> {
  const result = await clickhouse.query({
    query: `
      SELECT count() AS c
      FROM cost_events
      WHERE builder_id = {builder:String}
        AND metric = {metric:String}
        AND pricing_status IN ('needs_input','pending')
    `,
    query_params: {
      builder: builderId,
      metric,
    },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<Record<string, unknown>>;
  return Number(rows[0]?.['c'] ?? 0) > 0;
}

async function hasRemainingLlmPending(
  builderId: string,
  provider: string,
  model: string,
): Promise<boolean> {
  const result = await clickhouse.query({
    query: `
      SELECT count() AS c
      FROM cost_events
      WHERE builder_id = {builder:String}
        AND provider = {provider:String}
        AND model = {model:String}
        AND isNull(metric)
        AND pricing_status IN ('needs_input','pending')
    `,
    query_params: {
      builder: builderId,
      provider,
      model,
    },
    format: 'JSONEachRow',
  });
  const rows = (await result.json()) as Array<Record<string, unknown>>;
  return Number(rows[0]?.['c'] ?? 0) > 0;
}

type OnboardingKey =
  | { kind: 'llm'; provider: string; model: string }
  | { kind: 'metric'; metric: string };

async function resolveOnboarding(builderId: string, key: OnboardingKey): Promise<void> {
  await withRLS(builderId, async (tx) => {
    const whereFragment: SQL =
      key.kind === 'metric'
        ? drizzleSql`metric = ${key.metric}`
        : drizzleSql`provider = ${key.provider} AND model = ${key.model}`;

    const result = await tx.execute<{ id: string }>(drizzleSql`
      UPDATE pricing_onboarding_tasks
      SET status = 'resolved', resolved_at = NOW()
      WHERE builder_id = ${builderId}::uuid
        AND ${whereFragment}
        AND status = 'open'
      RETURNING id
    `);
    const rows = unwrapRows<{ id: string }>(result);
    const details =
      key.kind === 'metric' ? { metric: key.metric } : { provider: key.provider, model: key.model };
    for (const r of rows) {
      await auditLog(tx, {
        builder_id: builderId,
        actor_type: 'system',
        actor_id: 'backfill',
        action: AuditAction.ONBOARDING_RESOLVED,
        resource_type: 'pricing_onboarding_tasks',
        resource_id: r.id,
        details,
      });
    }
  });
}

export async function runBackfill(): Promise<{ groups: number; updated: number }> {
  const groups = await getPendingGroups();
  let updated = 0;

  for (const group of groups) {
    if (group.metric != null) {
      const prices = await findMetricPrices(
        group.builder_id,
        group.metric,
        group.min_ts,
        group.max_ts,
      );
      if (prices.length === 0) continue;
      for (const price of prices) {
        await clickhouse.command({
          query: `
            ALTER TABLE cost_events UPDATE
              cost_usd = round(${METRIC_COST_EXPR}, 6),
              pricing_status = 'priced'
            WHERE builder_id = {builder:String}
              AND metric = {metric:String}
              AND pricing_status IN ('needs_input','pending')
              ${priceWindowClause(price)}
              AND ${METRIC_COST_EXPR} >= 0
              AND ${METRIC_COST_EXPR} <= {maxCostUsd:Float64}
          `,
          query_params: {
            ppuUsd: price.price_per_unit_usd,
            maxCostUsd: MAX_STORABLE_COST_USD,
            builder: group.builder_id,
            metric: group.metric,
            ...priceWindowParams(price),
          },
          clickhouse_settings: {
            mutations_sync: '1',
          },
        });
      }
      if (await hasRemainingMetricPending(group.builder_id, group.metric)) {
        log.warn(
          { builder_id: group.builder_id, metric: group.metric },
          'backfill left metric rows pending after Decimal(10,6) range guard',
        );
      } else {
        await resolveOnboarding(group.builder_id, { kind: 'metric', metric: group.metric });
      }
      updated += 1;
      continue;
    }

    if (group.provider && group.model) {
      const prices = await findLlmPrices(
        group.builder_id,
        group.provider,
        group.model,
        group.min_ts,
        group.max_ts,
      );
      if (prices.length === 0) continue;
      for (const price of prices) {
        await clickhouse.command({
          query: `
            ALTER TABLE cost_events UPDATE
              cost_usd = round(${LLM_COST_EXPR}, 6),
              pricing_status = 'priced'
            WHERE builder_id = {builder:String}
              AND provider = {provider:String}
              AND model = {model:String}
              AND isNull(metric)
              AND pricing_status IN ('needs_input','pending')
              ${priceWindowClause(price)}
              AND ${LLM_COST_EXPR} >= 0
              AND ${LLM_COST_EXPR} <= {maxCostUsd:Float64}
          `,
          query_params: {
            inUsd: price.input_per_1m,
            outUsd: price.output_per_1m,
            maxCostUsd: MAX_STORABLE_COST_USD,
            builder: group.builder_id,
            provider: group.provider,
            model: group.model,
            ...priceWindowParams(price),
          },
          clickhouse_settings: {
            mutations_sync: '1',
          },
        });
      }
      if (await hasRemainingLlmPending(group.builder_id, group.provider, group.model)) {
        log.warn(
          { builder_id: group.builder_id, provider: group.provider, model: group.model },
          'backfill left LLM rows pending after Decimal(10,6) range guard',
        );
      } else {
        await resolveOnboarding(group.builder_id, {
          kind: 'llm',
          provider: group.provider,
          model: group.model,
        });
      }
      updated += 1;
    }
  }

  log.info({ groups: groups.length, updated }, 'backfill pass complete');
  return { groups: groups.length, updated };
}
