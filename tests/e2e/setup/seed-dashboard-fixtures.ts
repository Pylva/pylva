// Deterministic dashboard fixtures for the Playwright e2e suite.
// Usage: pnpm exec tsx tests/e2e/setup/seed-dashboard-fixtures.ts
//
// db/seed.ts randomizes token counts/costs (Math.random), which is unusable
// for e2e/visual assertions — this script inserts FIXED values against the
// seeded `alice-free` builder: ClickHouse cost_events timestamped a few hours
// ago (so the default 30-day dashboard window always includes them, via the
// raw-events boundary-day branch of the union queries) and Postgres invoices
// with pinned UUIDs. Customer ids deliberately include a very long id (from
// the bug-report screenshots) and an Arabic id (RTL is a product constraint).
//
// Idempotent: invoices/customers upsert on fixed keys; cost_events are
// lightweight-DELETEd for the fixture customer ids before re-insert.

import postgres from 'postgres';
import { createClient } from '@clickhouse/client';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DASHBOARD_ORG_SLUG,
  FIXTURE_CUSTOMER_IDS,
  FIXTURE_CUSTOMER_UUID,
  FIXTURE_CYCLE_UUID,
  FIXTURE_INVOICE_IDS,
} from './fixtures.js';

const SEED_ENV_DEFAULTS = {
  DATABASE_URL: 'postgresql://pylva:pylva_dev@localhost:5432/pylva',
  CLICKHOUSE_URL: 'http://localhost:8123',
} as const;

function chTimestamp(date: Date): string {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

async function main(): Promise<void> {
  for (const [name, value] of Object.entries(SEED_ENV_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(process.env, name)) {
      process.env[name] = value;
    }
  }

  const sql = postgres(process.env.DATABASE_URL!);
  const ch = createClient({ url: process.env.CLICKHOUSE_URL! });

  try {
    const builders = await sql`SELECT id FROM builders WHERE slug = ${DASHBOARD_ORG_SLUG} LIMIT 1`;
    if (builders.length === 0) {
      throw new Error(`builder "${DASHBOARD_ORG_SLUG}" not found — run \`pnpm db:seed\` first`);
    }
    const builderId = builders[0]!.id as string;

    // --- ClickHouse: fixed-value events, a few hours old ---
    // Wipe ALL of the builder's events first (db/seed.ts inserts Math.random
    // ones for alice-free) so totals AND row order are fully deterministic —
    // the visual-regression screenshots depend on that. The dashboard union
    // queries read the daily AGGREGATE tables for mid-window days, so those
    // must be wiped too, not just the raw table.
    const customerIds = Object.values(FIXTURE_CUSTOMER_IDS);
    const eventTables = [
      'cost_events',
      'cost_customer_daily_agg',
      'cost_model_daily_agg',
      'cost_daily_agg_v2',
    ];
    for (const table of eventTables) {
      try {
        await ch.command({
          query: `DELETE FROM ${table} WHERE builder_id = '${builderId}'`,
        });
      } catch (err) {
        // Lightweight DELETE unsupported here — duplicate fixture spend is
        // harmless for layout assertions; visual baselines assume a fresh
        // database (CI always has one).
        console.warn(`  ! could not wipe ${table}: ${String(err).slice(0, 120)}`);
      }
    }

    const now = Date.now();
    const models = [
      { provider: 'openai', model: 'gpt-4o', tokensIn: 1200, tokensOut: 400, costUsd: 0.0071 },
      {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        tokensIn: 900,
        tokensOut: 300,
        costUsd: 0.0012,
      },
      {
        provider: 'openai',
        model: 'gpt-4o-mini',
        tokensIn: 2400,
        tokensOut: 800,
        costUsd: 0.0008,
      },
    ];
    const events = [];
    for (const [custIdx, customerId] of customerIds.entries()) {
      for (const [modelIdx, m] of models.entries()) {
        // Distinct per-customer event counts → distinct spend totals, so the
        // spend-descending row order never ties (screenshot determinism).
        for (let i = 0; i < 4 - custIdx; i++) {
          events.push({
            timestamp: chTimestamp(
              new Date(now - (2 * 3600_000 + (custIdx * 12 + modelIdx * 4 + i) * 60_000)),
            ),
            builder_id: builderId,
            trace_id: crypto.randomUUID(),
            span_id: crypto.randomUUID(),
            customer_id: customerId,
            provider: m.provider,
            model: m.model,
            operation: 'chat.completions',
            step_name: `step_${modelIdx}`,
            tokens_in: m.tokensIn,
            tokens_out: m.tokensOut,
            cost_usd: m.costUsd,
            latency_ms: 850,
            status: 'success',
            cost_source: 'auto',
            instrumentation_tier: 'sdk_wrapper',
            stream_aborted: 0,
            abort_savings: 0,
            metadata: '',
          });
        }
      }
    }
    await ch.insert({ table: 'cost_events', values: events, format: 'JSONEachRow' });
    console.log(`  ✓ ${events.length} deterministic ClickHouse events (${DASHBOARD_ORG_SLUG})`);

    // --- Postgres: customer + invoices with pinned ids ---
    await sql`
      INSERT INTO customers (id, builder_id, external_id, name)
      VALUES (${FIXTURE_CUSTOMER_UUID}, ${builderId}, ${FIXTURE_CUSTOMER_IDS.normal}, 'Orbit Support')
      ON CONFLICT (builder_id, external_id) DO NOTHING
    `;
    const customers = await sql`
      SELECT id FROM customers
      WHERE builder_id = ${builderId} AND external_id = ${FIXTURE_CUSTOMER_IDS.normal}
      LIMIT 1
    `;
    const customerUuid = customers[0]!.id as string;

    const lineItems = [
      {
        description: 'GPT-4o input tokens',
        metric: 'tokens_in',
        quantity: 1_250_000,
        unit_price_usd: 0.0000025,
        total_usd: 3.13,
        pricing_version: 2,
      },
      {
        description: 'تكلفة الاستدعاءات',
        metric: 'api_calls',
        quantity: 120,
        unit_price_usd: 0.05,
        total_usd: 6,
        pricing_version: 2,
      },
    ];

    // Distinct created_at per invoice: the list orders by created_at DESC and
    // ties would make row order (and screenshots) non-deterministic.
    const invoices = [
      {
        id: FIXTURE_INVOICE_IDS.paid,
        status: 'paid',
        amount: '42.50',
        hasUnpriced: false,
        cycle: null as string | null,
        createdAt: '2026-06-15T12:00:00Z',
      },
      {
        id: FIXTURE_INVOICE_IDS.draftUnpriced,
        status: 'draft',
        amount: '17.25',
        hasUnpriced: true,
        cycle: null as string | null,
        createdAt: '2026-06-14T12:00:00Z',
      },
      {
        id: FIXTURE_INVOICE_IDS.splitCycle,
        status: 'pending',
        amount: '99.00',
        hasUnpriced: false,
        cycle: FIXTURE_CYCLE_UUID,
        createdAt: '2026-06-13T12:00:00Z',
      },
    ];
    for (const inv of invoices) {
      await sql`
        INSERT INTO invoices
          (id, builder_id, customer_id, amount_usd, period_start, period_end, status,
           line_items, billing_cycle_id, pricing_version, has_unpriced_events, created_at)
        VALUES
          (${inv.id}, ${builderId}, ${customerUuid}, ${inv.amount},
           '2026-06-01T00:00:00Z', '2026-07-01T00:00:00Z', ${inv.status},
           ${sql.json(lineItems)}, ${inv.cycle}, 2, ${inv.hasUnpriced}, ${inv.createdAt})
        ON CONFLICT (id) DO UPDATE SET
          amount_usd = EXCLUDED.amount_usd,
          status = EXCLUDED.status,
          line_items = EXCLUDED.line_items,
          billing_cycle_id = EXCLUDED.billing_cycle_id,
          has_unpriced_events = EXCLUDED.has_unpriced_events,
          created_at = EXCLUDED.created_at
      `;
    }
    console.log(`  ✓ ${invoices.length} fixture invoices`);
  } finally {
    await sql.end();
    await ch.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  main().catch((err) => {
    console.error('dashboard fixture seed failed:', err);
    process.exit(1);
  });
}
