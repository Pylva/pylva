// Factory for `PeriodAggregates` shapes used by anomaly detector +
// runner tests. Replaces the per-test `makeAggregate(...)` helpers
// that were copy-pasted across `tests/anomaly/*`.
//
// Usage:
//
//   import { makeCostAggregate, perCustomerAggregate } from '../_helpers/cost-aggregate-fixture';
//
//   // Builder-level fixture: one model slice, one customer.
//   const current = makeCostAggregate({
//     totalCost: 200,
//     models: [{ provider: 'openai', model: 'gpt-4o', cost_usd: 200 }],
//   });
//
//   // Per-customer fixture: same model, three customers, distinct costs.
//   const baseline = perCustomerAggregate({
//     'cust-1': { steps: [{ step_name: 'summarize', cost_usd: 50, iterations: 10 }] },
//     'cust-2': { steps: [{ step_name: 'summarize', cost_usd: 30, iterations: 6 }] },
//     'cust-3': { steps: [{ step_name: 'summarize', cost_usd: 20, iterations: 4 }] },
//   });
//
// Shapes mirror `src/lib/anomaly/clickhouse-queries.ts:PeriodAggregates`
// + `src/lib/rules/margin-diagnosis.ts:{Stepped,Modeled,Sourced}Slice`.

import type { PeriodAggregates, PeriodSlices } from '../../src/lib/anomaly/clickhouse-queries.js';
import type {
  ModeledSlice,
  SourcedSlice,
  SteppedSlice,
} from '../../src/lib/rules/margin-diagnosis.js';

interface AggregateInput {
  totalCost?: number;
  totalTokensIn?: number;
  totalTokensOut?: number;
  steps?: SteppedSlice[];
  models?: ModeledSlice[];
  sources?: SourcedSlice[];
}

/**
 * Builder-level aggregate (no per-customer breakdown). The
 * `byCustomer` and `costByCustomer` maps are empty — useful when the
 * code under test only walks `agg.all` / `agg.total_cost_usd`.
 */
export function makeCostAggregate(input: AggregateInput = {}): PeriodAggregates {
  const all: PeriodSlices = {
    steps: input.steps ?? [],
    models: input.models ?? [],
    sources: input.sources ?? [],
  };
  return {
    total_cost_usd: input.totalCost ?? 0,
    total_tokens_in: input.totalTokensIn ?? 0,
    total_tokens_out: input.totalTokensOut ?? 0,
    all,
    byCustomer: new Map(),
    costByCustomer: new Map(),
  };
}

/**
 * Per-customer aggregate. Pass a map of customerId → slices and the
 * factory builds the byCustomer + costByCustomer indexes plus
 * collapses `agg.all` by key (matching the production `collapseByKey`
 * behavior — see `src/lib/anomaly/clickhouse-queries.ts`).
 */
export function perCustomerAggregate(
  byCustomer: Record<string, Partial<PeriodSlices>>,
  totalsOverride: { totalTokensIn?: number; totalTokensOut?: number } = {},
): PeriodAggregates {
  const byCustomerMap = new Map<string | null, PeriodSlices>();
  const costByCustomer = new Map<string | null, number>();
  let totalCost = 0;

  for (const [customerId, slices] of Object.entries(byCustomer)) {
    const filled: PeriodSlices = {
      steps: slices.steps ?? [],
      models: slices.models ?? [],
      sources: slices.sources ?? [],
    };
    byCustomerMap.set(customerId, filled);
    const customerCost = filled.steps.reduce((sum, s) => sum + s.cost_usd, 0);
    costByCustomer.set(customerId, customerCost);
    totalCost += customerCost;
  }

  // Collapse byCustomer into agg.all (matches collapseByKey production behavior).
  const all = collapseByKey(byCustomerMap);
  return {
    total_cost_usd: totalCost,
    total_tokens_in: totalsOverride.totalTokensIn ?? 0,
    total_tokens_out: totalsOverride.totalTokensOut ?? 0,
    all,
    byCustomer: byCustomerMap,
    costByCustomer,
  };
}

const NULL_KEY = '\0';

function collapseByKey(byCustomer: Map<string | null, PeriodSlices>): PeriodSlices {
  const stepSums = new Map<string, SteppedSlice>();
  const modelSums = new Map<string, ModeledSlice>();
  const sourceSums = new Map<string, SourcedSlice>();
  for (const slices of byCustomer.values()) {
    for (const s of slices.steps) {
      const k = s.step_name ?? NULL_KEY;
      const acc = stepSums.get(k);
      if (acc) {
        acc.cost_usd += s.cost_usd;
        acc.iterations += s.iterations;
      } else {
        stepSums.set(k, { ...s });
      }
    }
    for (const m of slices.models) {
      const k = `${m.provider ?? NULL_KEY}|${m.model ?? NULL_KEY}`;
      const acc = modelSums.get(k);
      if (acc) acc.cost_usd += m.cost_usd;
      else modelSums.set(k, { ...m });
    }
    for (const src of slices.sources) {
      const k = src.source ?? NULL_KEY;
      const acc = sourceSums.get(k);
      if (acc) acc.cost_usd += src.cost_usd;
      else sourceSums.set(k, { ...src });
    }
  }
  return {
    steps: [...stepSums.values()],
    models: [...modelSums.values()],
    sources: [...sourceSums.values()],
  };
}
