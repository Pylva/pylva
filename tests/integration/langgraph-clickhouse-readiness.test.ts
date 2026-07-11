import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { createClient } from '@clickhouse/client';
import { NextRequest } from 'next/server.js';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
  Provider,
  type IngestResponse,
  type TelemetryEvent,
} from '@pylva/shared';
import { clickhouse } from '../../src/lib/clickhouse/client.js';
import { checkClickHouseReadiness } from '../../src/lib/clickhouse/readiness.js';
import { toCompositeCustomerId } from '../../src/lib/clickhouse/customer-id.js';
import { getCustomerCostSummary, getOverview } from '../../src/lib/clickhouse/dashboard-queries.js';
import { getUsageForPeriod } from '../../src/lib/billing/clickhouse-usage.js';
import { handleTelemetryIngest } from '../../src/lib/ingest/public-handler.js';
import { GET as pricingPreview } from '../../src/app/api/v1/billing/pricing/preview/route.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const CLICKHOUSE_URL = process.env['CLICKHOUSE_URL'] ?? 'http://localhost:8123';

const agents = ['support_triage', 'invoice_recon', 'onboarding_audit'] as const;
const customerIds = agents.flatMap((agent) =>
  [1, 2, 3].map((index) => `lg_${agent}_cust_${index}`),
);

let sql: ReturnType<typeof postgres>;
let builderId = '';

function eventFor(params: {
  agent: (typeof agents)[number];
  customerId: string;
  timestamp: string;
}): TelemetryEvent {
  return {
    schema_version: '1.6',
    run_id: crypto.randomUUID(),
    parent_run_id: null,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    customer_id: params.customerId,
    step_name: `${params.agent}_solve`,
    model: 'gpt-4o-mini',
    provider: Provider.OPENAI,
    tokens_in: 1000,
    tokens_out: 500,
    latency_ms: 125,
    tool_name: null,
    status: EventStatus.SUCCESS,
    framework: Framework.LANGGRAPH,
    instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    cost_source: CostSource.AUTO,
    metric: null,
    metric_value: null,
    stream_aborted: false,
    abort_savings_usd: 0,
    sdk_version: 'integration-test',
    timestamp: params.timestamp,
    metadata: null,
  };
}

async function createBuilder(): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (
      ${`langgraph-clickhouse-${suffix}@example.com`},
      'LangGraph ClickHouse Readiness',
      'pro',
      ${`langgraph-clickhouse-${suffix}`}
    )
    RETURNING id
  `;
  return row!.id;
}

async function installDeterministicLlmPricing(id: string): Promise<void> {
  await sql`
    INSERT INTO custom_pricing (
      builder_id, provider, model, metric, price_per_unit_usd,
      input_per_1m_usd, output_per_1m_usd, effective_from, source
    ) VALUES (
      ${id}, 'openai', 'gpt-4o-mini', NULL, 0.000001,
      1.00, 2.00, NOW() - INTERVAL '1 day', 'builder_manual'
    )
  `;
}

async function ingestLangGraphCohort(id: string, timestamp: string): Promise<IngestResponse> {
  const events = agents.flatMap((agent) =>
    [1, 2, 3].map((index) =>
      eventFor({
        agent,
        customerId: `lg_${agent}_cust_${index}`,
        timestamp,
      }),
    ),
  );
  const response = await handleTelemetryIngest({
    builderId: id,
    keyId: 'integration-key',
    rawBody: JSON.stringify({
      batch_id: crypto.randomUUID(),
      sdk_version: 'integration-test',
      events,
    }),
  });
  expect(response.status).toBe(200);
  return JSON.parse(response.body) as IngestResponse;
}

async function clickhouseRows(id: string): Promise<
  Array<{
    customer_id: string;
    cost_usd: string | null;
    pricing_status: string;
    metadata: string;
  }>
> {
  const result = await clickhouse.query({
    query: `
      SELECT customer_id, cost_usd, pricing_status, metadata
        FROM cost_events
       WHERE builder_id = {builder:String}
       ORDER BY customer_id
    `,
    query_params: { builder: id },
    format: 'JSONEachRow',
  });
  return (await result.json()) as Array<{
    customer_id: string;
    cost_usd: string | null;
    pricing_status: string;
    metadata: string;
  }>;
}

function urlForClickHouseDatabase(database: string): string {
  const url = new URL(CLICKHOUSE_URL);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  builderId = await createBuilder();
  await installDeterministicLlmPricing(builderId);
});

afterAll(async () => {
  if (builderId) {
    await clickhouse.command({
      query: 'ALTER TABLE cost_events DELETE WHERE builder_id = {builder:String}',
      query_params: { builder: builderId },
      clickhouse_settings: { mutations_sync: '1' },
    });
    await sql`DELETE FROM builders WHERE id = ${builderId}`;
  }
  await sql.end();
});

describe('LangGraph ClickHouse launch readiness', () => {
  it('discovers 9 downstream customers and serves dashboard plus billing reads from real ClickHouse', async () => {
    const now = new Date();
    const eventTime = new Date(now.getTime() - 5 * 60 * 1000);
    const timestamp = eventTime.toISOString();
    const response = await ingestLangGraphCohort(builderId, timestamp);

    expect(response).toMatchObject({ accepted: 9, rejected: 0 });

    const pgCustomers = await sql<{ external_id: string }[]>`
      SELECT external_id
        FROM customers
       WHERE builder_id = ${builderId}
       ORDER BY external_id
    `;
    expect(pgCustomers.map((row) => row.external_id)).toEqual([...customerIds].sort());

    const rows = await clickhouseRows(builderId);
    expect(rows).toHaveLength(9);
    expect(rows.every((row) => row.customer_id.startsWith(`${builderId}:`))).toBe(true);
    expect(rows.every((row) => row.pricing_status === 'priced')).toBe(true);
    expect(rows.every((row) => Number(row.cost_usd) > 0)).toBe(true);
    expect(new Set(rows.map((row) => JSON.parse(row.metadata).framework))).toEqual(
      new Set([Framework.LANGGRAPH]),
    );

    const range = {
      from: new Date(now.getTime() - 60 * 60 * 1000),
      to: new Date(now.getTime() + 60 * 60 * 1000),
    };
    const overview = await getOverview(builderId, range, {
      includeDemo: false,
      hasRealEvents: true,
    });
    expect(overview.event_count).toBe(9);
    expect(overview.customer_count).toBe(9);
    expect(overview.total_spend_usd).toBeGreaterThan(0);

    const summaries = await getCustomerCostSummary(builderId, range, { includeDemo: false });
    expect(summaries).toHaveLength(9);
    expect(summaries.every((summary) => summary.total_spend_usd > 0)).toBe(true);

    const billingCustomerExternalId = 'lg_invoice_recon_cust_1';
    const compositeCustomerId = toCompositeCustomerId(builderId, billingCustomerExternalId);
    const usage = await getUsageForPeriod({
      builderId,
      customerId: compositeCustomerId,
      from: range.from,
      to: range.to,
    });
    expect(usage.by_metric.input_tokens).toBe(1000);
    expect(usage.by_metric.output_tokens).toBe(500);
    expect(usage.has_unpriced).toBe(false);

    const [customer] = await sql<{ id: string }[]>`
      SELECT id
        FROM customers
       WHERE builder_id = ${builderId}
         AND external_id = ${billingCustomerExternalId}
    `;
    expect(customer?.id).toBeDefined();

    await sql`
      INSERT INTO customer_pricing (
        builder_id, customer_id, pricing_model, per_unit_rates,
        markup_pct, billing_period, version, effective_from
      ) VALUES (
        ${builderId}, ${customer!.id}, 'pay_as_you_go',
        ${sql.json({ input_tokens: 0.01, output_tokens: 0.02 })},
        0, 'monthly', 1, NOW() - INTERVAL '1 day'
      )
    `;

    const proposed = Buffer.from(
      JSON.stringify({
        pricing_model: 'pay_as_you_go',
        per_unit_rates: { input_tokens: 0.02, output_tokens: 0.04 },
        markup_pct: 0,
        billing_period: 'monthly',
      }),
    ).toString('base64');
    const previewUrl = new URL('http://localhost/api/v1/billing/pricing/preview');
    previewUrl.searchParams.set('customer_id', customer!.id);
    previewUrl.searchParams.set('proposed', proposed);
    const preview = await pricingPreview(
      new NextRequest(previewUrl, {
        headers: { 'x-builder-id': builderId },
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
    expect(preview.status).toBe(200);
    const body = (await preview.json()) as {
      current: { amount_usd: number };
      proposed: { amount_usd: number };
      delta_usd: number;
    };
    expect(body.current.amount_usd).toBeGreaterThan(0);
    expect(body.proposed.amount_usd).toBeGreaterThan(body.current.amount_usd);
    expect(body.delta_usd).toBeGreaterThan(0);
  });

  it(
    'runs ClickHouse-only setup against an empty database without touching Postgres',
    async () => {
      const database = `am_ch_setup_${crypto.randomBytes(6).toString('hex')}`;
      await clickhouse.command({ query: `CREATE DATABASE ${database}` });
      const isolatedUrl = urlForClickHouseDatabase(database);
      const isolatedClient = createClient({ url: isolatedUrl });

      try {
        const before = await sql<{ c: string }[]>`
          SELECT count(*)::text AS c FROM builders WHERE id = ${builderId}
        `;
        expect(before[0]?.c).toBe('1');

        const result = spawnSync('pnpm', ['db:setup'], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            SKIP_POSTGRES: 'true',
            CLICKHOUSE_URL: isolatedUrl,
          },
          encoding: 'utf8',
        });
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

        const readiness = await checkClickHouseReadiness(isolatedClient);
        expect(readiness.ready).toBe(true);

        const after = await sql<{ c: string }[]>`
          SELECT count(*)::text AS c FROM builders WHERE id = ${builderId}
        `;
        expect(after[0]?.c).toBe('1');
      } finally {
        await isolatedClient.close();
        await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${database}` });
      }
    },
    120_000,
  );
});
