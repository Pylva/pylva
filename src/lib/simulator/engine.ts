import { queryCostEvents } from '../clickhouse/client.js';
import { chTimestamp } from '../clickhouse/datetime.js';
import { assertBuilderId } from '../clickhouse/query-guard.js';
import { db } from '../db/client.js';
import { llmPricing } from '../db/schema.js';
import { and, inArray } from 'drizzle-orm';
import {
  OTHERS_CUSTOMER_ID,
  type SimulatorResult,
  type SimulatorBreakdown,
  type ModelSwap,
} from '@pylva/shared';
import type { ValidatedSimulatorRequest } from './validator.js';

const TOP_CUSTOMERS = 20;

interface AggRow {
  customer_id: string;
  provider: string;
  model: string;
  step_name: string | null;
  tokens_in: number;
  tokens_out: number;
  original_cost_usd: number;
  event_count: number;
}

interface PricingEntry {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

export async function runSimulation(
  builderId: string,
  jwtBuilderId: string,
  request: ValidatedSimulatorRequest,
): Promise<SimulatorResult> {
  assertBuilderId(builderId, jwtBuilderId);

  const from = chTimestamp(new Date(request.period_start));
  const to = chTimestamp(new Date(request.period_end));
  const customerFilter = request.customer_id ? 'AND customer_id = {customer_id:String}' : '';
  const params: Record<string, unknown> = { from, to };
  if (request.customer_id) params['customer_id'] = request.customer_id;

  const targetModels = request.model_swaps.map((s) => ({
    provider: s.to_provider,
    model: s.to_model,
  }));

  const [aggRows, freshnessRows, pricingMap] = await Promise.all([
    queryCostEvents(
      builderId,
      `SELECT
         customer_id,
         provider,
         model,
         step_name,
         sum(total_tokens_in) AS tokens_in,
         sum(total_tokens_out) AS tokens_out,
         sum(total_cost_usd) AS original_cost_usd,
         sum(event_count) AS event_count
       FROM cost_daily_agg_v2
       WHERE builder_id = {builder_id:String}
         AND day >= toDate({from:DateTime})
         AND day <= toDate({to:DateTime})
         ${customerFilter}
       GROUP BY customer_id, provider, model, step_name`,
      params,
    ),
    queryCostEvents(
      builderId,
      `SELECT max(day) AS freshness
       FROM cost_daily_agg_v2
       WHERE builder_id = {builder_id:String}`,
    ),
    batchLookupPricing(targetModels),
  ]);

  const rows: AggRow[] = (aggRows as Array<Record<string, string>>).map((r) => ({
    customer_id: r.customer_id ?? '',
    provider: r.provider ?? '',
    model: r.model ?? '',
    step_name: r.step_name || null,
    tokens_in: Number(r.tokens_in),
    tokens_out: Number(r.tokens_out),
    original_cost_usd: Number(r.original_cost_usd),
    event_count: Number(r.event_count),
  }));

  const freshnessRow = freshnessRows[0] as { freshness?: string } | undefined;
  const freshness = freshnessRow?.freshness ?? null;

  const swapKey = (provider: string, model: string) => `${provider}:${model}`;
  const swapIndex = new Map<string, ModelSwap>();
  for (const swap of request.model_swaps) {
    swapIndex.set(swapKey(swap.from_provider, swap.from_model), swap);
  }

  const warnings: string[] = [];
  const breakdown: SimulatorBreakdown[] = [];

  for (const row of rows) {
    const swap = swapIndex.get(swapKey(row.provider, row.model));
    let simulatedCost = row.original_cost_usd;
    let simulatedModel = row.model;

    if (swap) {
      const pricing = pricingMap.get(swapKey(swap.to_provider, swap.to_model));
      if (pricing) {
        simulatedCost =
          (row.tokens_in * pricing.input_per_1m + row.tokens_out * pricing.output_per_1m) /
          1_000_000;
        simulatedModel = swap.to_model;
      } else {
        const warnMsg = `Unknown pricing for ${swap.to_provider}/${swap.to_model}`;
        if (!warnings.includes(warnMsg)) warnings.push(warnMsg);
        simulatedCost = 0;
        simulatedModel = swap.to_model;
      }
    }

    breakdown.push({
      customer_id: row.customer_id,
      provider: row.provider,
      step_name: row.step_name,
      original_model: row.model,
      simulated_model: simulatedModel,
      original_cost_usd: row.original_cost_usd,
      simulated_cost_usd: simulatedCost,
      event_count: row.event_count,
    });
  }

  const topBreakdown = collapseToTopN(breakdown);

  const originalTotal = topBreakdown.reduce((sum, b) => sum + b.original_cost_usd, 0);
  const simulatedTotal = topBreakdown.reduce((sum, b) => sum + b.simulated_cost_usd, 0);
  const savingsUsd = originalTotal - simulatedTotal;
  const savingsPercent = originalTotal > 0 ? (savingsUsd / originalTotal) * 100 : 0;

  return {
    original_cost_usd: originalTotal,
    simulated_cost_usd: simulatedTotal,
    savings_usd: savingsUsd,
    savings_percent: Math.round(savingsPercent * 100) / 100,
    breakdown: topBreakdown,
    period_start: request.period_start,
    period_end: request.period_end,
    freshness_timestamp: freshness,
    warnings,
  };
}

async function batchLookupPricing(
  models: Array<{ provider: string; model: string }>,
): Promise<Map<string, PricingEntry>> {
  if (models.length === 0) return new Map();

  const modelNames = [...new Set(models.map((m) => m.model))];
  const providerNames = [...new Set(models.map((m) => m.provider))];
  const rows = await db
    .select({
      provider: llmPricing.provider,
      model: llmPricing.model,
      input_per_1m: llmPricing.input_per_1m,
      output_per_1m: llmPricing.output_per_1m,
    })
    .from(llmPricing)
    .where(and(inArray(llmPricing.model, modelNames), inArray(llmPricing.provider, providerNames)));

  const result = new Map<string, PricingEntry>();
  for (const row of rows) {
    const key = `${row.provider}:${row.model}`;
    if (!result.has(key)) {
      result.set(key, {
        provider: row.provider,
        model: row.model,
        input_per_1m: Number(row.input_per_1m),
        output_per_1m: Number(row.output_per_1m),
      });
    }
  }
  return result;
}

function collapseToTopN(breakdown: SimulatorBreakdown[]): SimulatorBreakdown[] {
  const byCustomer = new Map<string, number>();
  for (const b of breakdown) {
    byCustomer.set(b.customer_id, (byCustomer.get(b.customer_id) ?? 0) + b.original_cost_usd);
  }

  const sorted = [...byCustomer.entries()].sort((a, b) => b[1] - a[1]);
  if (sorted.length <= TOP_CUSTOMERS) return breakdown;

  const topIds = new Set(sorted.slice(0, TOP_CUSTOMERS).map(([id]) => id));
  const topRows = breakdown.filter((b) => topIds.has(b.customer_id));

  const othersRows = breakdown.filter((b) => !topIds.has(b.customer_id));
  if (othersRows.length > 0) {
    topRows.push({
      customer_id: OTHERS_CUSTOMER_ID,
      provider: '',
      step_name: null,
      original_model: '',
      simulated_model: '',
      original_cost_usd: othersRows.reduce((s, b) => s + b.original_cost_usd, 0),
      simulated_cost_usd: othersRows.reduce((s, b) => s + b.simulated_cost_usd, 0),
      event_count: othersRows.reduce((s, b) => s + b.event_count, 0),
    });
  }

  return topRows;
}
