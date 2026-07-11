import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';
import {
  CostSource,
  EventStatus,
  Framework,
  IngestWarningCode,
  InstrumentationTier,
  type IngestResponse,
  type TelemetryEvent,
} from '@pylva/shared';
import { clickhouse } from '../../src/lib/clickhouse/client.js';
import { getModelBreakdown } from '../../src/lib/clickhouse/dashboard-queries.js';
import { handleTelemetryIngest } from '../../src/lib/ingest/public-handler.js';
import { resetPricingCaches } from '../../src/lib/ingest/pricing-lookup.js';
import { _resetBufferForTests } from '../../src/lib/ingest/last-seen-buffer.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const EVENT_TIMESTAMP = new Date(Date.now() - 60_000).toISOString();

let sql: ReturnType<typeof postgres>;
const builderIds: string[] = [];

async function createBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`${label}-${suffix}@example.com`}, ${label}, 'pro', ${`${label}-${suffix}`})
    RETURNING id
  `;
  const builderId = row!.id;
  builderIds.push(builderId);
  return builderId;
}

function event(overrides: Partial<TelemetryEvent> = {}): TelemetryEvent {
  return {
    schema_version: '1.6',
    run_id: crypto.randomUUID(),
    parent_run_id: null,
    trace_id: crypto.randomUUID(),
    span_id: crypto.randomUUID(),
    parent_span_id: null,
    customer_id: `cust_${crypto.randomBytes(3).toString('hex')}`,
    step_name: 'flexible_provider_model',
    model: 'ollama/llama3.1-8b',
    provider: 'ollama',
    tokens_in: 100,
    tokens_out: 50,
    latency_ms: 12,
    tool_name: null,
    status: EventStatus.SUCCESS,
    framework: Framework.NONE,
    instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    cost_source: CostSource.AUTO,
    metric: null,
    metric_value: null,
    stream_aborted: false,
    abort_savings_usd: 0,
    sdk_version: 'integration-test',
    timestamp: EVENT_TIMESTAMP,
    metadata: null,
    ...overrides,
  };
}

async function ingest(
  builderId: string,
  events: TelemetryEvent[],
): Promise<{ status: number; body: IngestResponse }> {
  const response = await handleTelemetryIngest({
    builderId,
    keyId: 'integration-key',
    rawBody: JSON.stringify({
      batch_id: crypto.randomUUID(),
      sdk_version: 'integration-test',
      events,
    }),
  });
  return {
    status: response.status,
    body: JSON.parse(response.body) as IngestResponse,
  };
}

async function clickhouseRows<T extends Record<string, unknown>>(
  builderId: string,
  spanIds: string[],
): Promise<T[]> {
  const result = await clickhouse.query({
    query: `
      SELECT span_id, provider, model, cost_usd, pricing_status
      FROM cost_events
      WHERE builder_id = {builder:String}
        AND span_id IN {spanIds:Array(UUID)}
      ORDER BY span_id
    `,
    query_params: {
      builder: builderId,
      spanIds,
    },
    format: 'JSONEachRow',
  });
  return (await result.json()) as T[];
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
): Promise<T> {
  let last = await read();
  for (let i = 0; i < 25; i++) {
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
    last = await read();
  }
  return last;
}

async function insertCustomLlmPrice(params: {
  builderId: string;
  provider: string;
  model: string;
}): Promise<void> {
  await sql`
    INSERT INTO custom_pricing (
      builder_id, provider, model, metric,
      price_per_unit_usd, input_per_1m_usd, output_per_1m_usd,
      effective_from, source
    ) VALUES (
      ${params.builderId}, ${params.provider}, ${params.model}, NULL,
      0.000001, 1.00, 2.00,
      NOW() - INTERVAL '1 day', 'builder_manual'
    )
  `;
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
});

beforeEach(() => {
  resetPricingCaches();
  _resetBufferForTests();
});

afterAll(async () => {
  for (const builderId of builderIds) {
    await clickhouse.command({
      query: 'ALTER TABLE cost_events DELETE WHERE builder_id = {builder:String}',
      query_params: { builder: builderId },
      clickhouse_settings: {
        mutations_sync: '1',
      },
    });
  }
  if (builderIds.length > 0) {
    await sql`DELETE FROM builders WHERE id IN ${sql(builderIds)}`;
  }
  await sql.end();
});

describe('flexible provider/model ingest', () => {
  it('accepts unpriced arbitrary provider/model strings and preserves exact values', async () => {
    const builderId = await createBuilder('flex-unpriced');
    const unpriced = event({
      provider: 'ollama',
      model: 'ollama/llama3.1-8b',
    });

    const response = await ingest(builderId, [unpriced]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 1, rejected: 0 });
    expect(response.body.warnings).toEqual([
      expect.objectContaining({
        code: IngestWarningCode.NEEDS_PRICING_INPUT,
        provider: 'ollama',
        model: 'ollama/llama3.1-8b',
      }),
    ]);

    const rows = await clickhouseRows<{
      span_id: string;
      provider: string;
      model: string;
      cost_usd: string | null;
      pricing_status: string;
    }>(builderId, [unpriced.span_id]);
    expect(rows).toEqual([
      expect.objectContaining({
        provider: 'ollama',
        model: 'ollama/llama3.1-8b',
        cost_usd: null,
        pricing_status: 'needs_input',
      }),
    ]);

    const sources = await waitFor(
      () => sql<{ slug: string; display_name: string }[]>`
        SELECT slug, display_name
        FROM cost_sources
        WHERE builder_id = ${builderId}
      `,
      (rows) => rows.length > 0,
    );
    expect(sources).toEqual([
      expect.objectContaining({
        slug: 'ollama',
        display_name: 'ollama',
      }),
    ]);

    const tasks = await waitFor(
      () => sql<{ provider: string | null; model: string | null; status: string }[]>`
        SELECT provider, model, status
        FROM pricing_onboarding_tasks
        WHERE builder_id = ${builderId}
      `,
      (rows) => rows.length > 0,
    );
    expect(tasks).toEqual([
      expect.objectContaining({
        provider: 'ollama',
        model: 'ollama/llama3.1-8b',
        status: 'open',
      }),
    ]);
  });

  it('prices arbitrary provider/model strings from custom pricing and aggregates exact names', async () => {
    const builderId = await createBuilder('flex-priced');
    const provider = 'zhipu.chat';
    const model = 'ft:gpt-4o-mini:org/name+v1@prod';
    await insertCustomLlmPrice({ builderId, provider, model });

    const priced = event({ provider, model });
    const response = await ingest(builderId, [priced]);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ accepted: 1, rejected: 0 });
    expect(response.body.warnings).toBeUndefined();

    const rows = await clickhouseRows<{
      span_id: string;
      provider: string;
      model: string;
      cost_usd: string | null;
      pricing_status: string;
    }>(builderId, [priced.span_id]);
    expect(rows).toEqual([
      expect.objectContaining({
        provider,
        model,
        pricing_status: 'priced',
      }),
    ]);
    expect(Number(rows[0]!.cost_usd)).toBeCloseTo(0.0002, 6);

    const range = {
      from: new Date(Date.now() - 5 * 60_000),
      to: new Date(Date.now() + 5 * 60_000),
    };
    const breakdown = await getModelBreakdown(builderId, range, { includeDemo: false });
    expect(breakdown).toEqual([
      expect.objectContaining({
        provider,
        model,
        tokens_in: 100,
        tokens_out: 50,
        call_count: 1,
      }),
    ]);
  });
});
