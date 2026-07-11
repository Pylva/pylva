// B2a — Per-builder demo data seed (D11 / §4.9).
//
// Invoked from org-creation path on first login (`findOrCreateBuilderForUser`
// in src/lib/auth/org.ts when `isNew` is true). Idempotent per builder:
// if any cost_events.is_demo=true row already exists for the builder we
// skip. The dashboard auto-hides demo data once a real (non-demo) event
// lands (§4.9 D11 + I-T1-13).
//
// What this inserts for a single builder:
//   - 10 end-user customers (acme-corp ... kappa-ventures)
//   - ~5,000 cost_events spread across 30 days back
//   - Model mix: GPT-4o 40% / Claude Sonnet 30% / GPT-4o-mini 15% /
//                Claude Haiku 10% / other 5%
//   - Realistic step_name labels
//   - Parent-child trace structure (100 traces × 10–50 spans)
//   - acme-corp approaches a $50/day budget (demo rule template)
//   - gamma-co negative margin (demo margin_protection template)
//
// Usage:
//   import { seedDemoData } from './scripts/seed-demo-data.js';
//   await seedDemoData({ builderId: '...' });
//
// Direct CLI (for dev smoke):
//   pnpm exec tsx scripts/seed-demo-data.ts <builder-id>

import crypto from 'node:crypto';
import postgres from 'postgres';
import { createClient } from '@clickhouse/client';

const DEMO_CUSTOMERS = [
  'acme-corp',
  'beta-labs',
  'gamma-co',
  'delta-inc',
  'epsilon-ai',
  'zeta-works',
  'eta-systems',
  'theta-corp',
  'iota-labs',
  'kappa-ventures',
];

const MODEL_MIX: Array<{
  provider: string;
  model: string;
  weight: number;
  input_per_1m: number;
  output_per_1m: number;
}> = [
  { provider: 'openai', model: 'gpt-4o', weight: 0.4, input_per_1m: 2.5, output_per_1m: 10.0 },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    weight: 0.3,
    input_per_1m: 3.0,
    output_per_1m: 15.0,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    weight: 0.15,
    input_per_1m: 0.15,
    output_per_1m: 0.6,
  },
  {
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    weight: 0.1,
    input_per_1m: 0.25,
    output_per_1m: 1.25,
  },
  {
    provider: 'google',
    model: 'gemini-2.0-flash',
    weight: 0.05,
    input_per_1m: 0.1,
    output_per_1m: 0.4,
  },
];

const STEP_NAMES = [
  'authentication',
  'retrieval',
  'tool_call:search',
  'tool_call:db_query',
  'synthesis',
  'classification',
  'formatting',
];

const TRACES_PER_BUILDER = 100;
const MIN_SPANS_PER_TRACE = 10;
const MAX_SPANS_PER_TRACE = 50;

interface SeedOptions {
  builderId: string;
  databaseUrl?: string;
  clickhouseUrl?: string;
}

function pickModel(): (typeof MODEL_MIX)[number] {
  const r = Math.random();
  let acc = 0;
  for (const m of MODEL_MIX) {
    acc += m.weight;
    if (r <= acc) return m;
  }
  return MODEL_MIX[0]!;
}

function chSeconds(date: Date): string {
  // ClickHouse wants "YYYY-MM-DD HH:MM:SS"
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

function randBetween(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

function randInt(lo: number, hi: number): number {
  return Math.floor(randBetween(lo, hi + 1));
}

// acme-corp on demo-day-0 should land ~$47 against a $50 budget template.
// Biased spend curve: early days normal, today elevated.
function biasedCost(customerExternalId: string, daysAgo: number, baseCost: number): number {
  if (customerExternalId === 'acme-corp' && daysAgo === 0) return baseCost * 3.5;
  if (customerExternalId === 'gamma-co') return baseCost * 2.2; // negative margin demo
  return baseCost;
}

export async function seedDemoData(
  opts: SeedOptions,
): Promise<{ inserted: boolean; eventCount: number }> {
  const databaseUrl =
    opts.databaseUrl ??
    process.env['DATABASE_URL'] ??
    'postgresql://pylva:pylva_dev@localhost:5432/pylva';
  const clickhouseUrl =
    opts.clickhouseUrl ?? process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';

  const sql = postgres(databaseUrl);
  const ch = createClient({ url: clickhouseUrl });

  try {
    // Idempotency gate: if any is_demo=true event exists for this builder, skip.
    const existing = await ch.query({
      query: `
        SELECT count() AS c FROM cost_events
        WHERE builder_id = {builder_id:String} AND is_demo = 1
        LIMIT 1
      `,
      query_params: { builder_id: opts.builderId },
      format: 'JSONEachRow',
    });
    const rows = await existing.json<{ c: string }>();
    const existingCount = Number(rows[0]?.c ?? 0);
    if (existingCount > 0) {
      return { inserted: false, eventCount: 0 };
    }

    // Upsert the 10 demo customer rows and collect (external_id -> id) map.
    const customerIdByExternal = new Map<string, string>();
    for (const extId of DEMO_CUSTOMERS) {
      const [row] = await sql<Array<{ id: string }>>`
        INSERT INTO customers (builder_id, external_id, name, metadata)
        VALUES (${opts.builderId}, ${extId}, ${extId}, ${sql.json({ is_demo: true })})
        ON CONFLICT (builder_id, external_id) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
      `;
      customerIdByExternal.set(extId, row!.id);
    }

    // Build a flat list of cost_events.
    const events: Array<Record<string, unknown>> = [];
    const now = new Date();

    for (let traceIdx = 0; traceIdx < TRACES_PER_BUILDER; traceIdx++) {
      const traceId = crypto.randomUUID();
      const customerExtId = DEMO_CUSTOMERS[traceIdx % DEMO_CUSTOMERS.length]!;
      const daysAgo = traceIdx % 30;
      const traceTimestamp = new Date(
        now.getTime() - daysAgo * 86_400_000 - randInt(0, 23) * 3_600_000,
      );
      const spansInTrace = randInt(MIN_SPANS_PER_TRACE, MAX_SPANS_PER_TRACE);
      const rootSpanId = crypto.randomUUID();

      for (let spanIdx = 0; spanIdx < spansInTrace; spanIdx++) {
        const model = pickModel();
        const spanId = spanIdx === 0 ? rootSpanId : crypto.randomUUID();
        const parentSpanId = spanIdx === 0 ? null : rootSpanId;
        const stepName = STEP_NAMES[randInt(0, STEP_NAMES.length - 1)]!;
        const tokensIn = randInt(100, 2000);
        const tokensOut = randInt(50, 1000);
        const baseCost =
          (tokensIn * model.input_per_1m + tokensOut * model.output_per_1m) / 1_000_000;
        const costUsd = biasedCost(customerExtId, daysAgo, baseCost);
        const spanTimestamp = new Date(traceTimestamp.getTime() + spanIdx * 1000);

        events.push({
          timestamp: chSeconds(spanTimestamp),
          builder_id: opts.builderId,
          trace_id: traceId,
          span_id: spanId,
          parent_span_id: parentSpanId,
          customer_id: `${opts.builderId}:${customerExtId}`,
          provider: model.provider,
          model: model.model,
          operation: stepName.startsWith('tool_call:') ? 'tool.invoke' : 'chat.completions',
          step_name: stepName,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          cost_usd: Number(costUsd.toFixed(6)),
          pricing_status: 'priced',
          latency_ms: randInt(200, 3200),
          status: 'success',
          cost_source: 'auto',
          instrumentation_tier: 'sdk_wrapper',
          metric: null,
          metric_value: null,
          stream_aborted: 0,
          abort_savings: 0,
          metadata: '',
          is_demo: 1,
        });

        // Trace event count cap — keep total ~5,000 across all traces (cheap envelope).
        if (events.length >= 5000) break;
      }
      if (events.length >= 5000) break;
    }

    if (events.length > 0) {
      await ch.insert({
        table: 'cost_events',
        values: events,
        format: 'JSONEachRow',
      });
    }

    return { inserted: true, eventCount: events.length };
  } finally {
    await sql.end();
    await ch.close();
  }
}

// CLI entrypoint
const isDirectInvoke =
  import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('seed-demo-data.ts');
if (isDirectInvoke) {
  const builderId = process.argv[2];
  if (!builderId) {
    console.error('Usage: pnpm exec tsx scripts/seed-demo-data.ts <builder-id>');
    process.exit(1);
  }
  seedDemoData({ builderId })
    .then((res) => {
      if (res.inserted) {
        console.log(`Seeded ${res.eventCount} demo events for builder ${builderId}`);
      } else {
        console.log(`Skipped: builder ${builderId} already has demo data`);
      }
    })
    .catch((err) => {
      console.error('Seed failed:', err);
      process.exit(1);
    });
}
