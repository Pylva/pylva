import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { NextRequest } from 'next/server.js';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
  Provider,
  TokenCountSource,
  type IngestResponse,
} from '@pylva/shared';
import { clickhouse } from '../../src/lib/clickhouse/client.js';
import { toCompositeCustomerId } from '../../src/lib/clickhouse/customer-id.js';
import { getCustomerCostSummary, getOverview } from '../../src/lib/clickhouse/dashboard-queries.js';
import { getUsageForPeriod } from '../../src/lib/billing/clickhouse-usage.js';
import { handleTelemetryIngest } from '../../src/lib/ingest/public-handler.js';
import { resetPricingCaches } from '../../src/lib/ingest/pricing-lookup.js';
import { resetCostSourcePricingCache } from '../../src/lib/ingest/cost-source-pricing.js';
import { GET as pricingPreview } from '../../src/app/api/v1/billing/pricing/preview/route.js';
import { init, track, reportUsage, flush, enqueue, currentContext } from '../../packages/sdk-ts/src/index.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const SDK_KEY = 'pv_live_aabbccdd_' + 'a'.repeat(32);
const SDK_ENDPOINT = 'https://sdk-e2e.pylva.test';

type LlmSpec = {
  provider: Provider;
  model: string;
  tokensIn: number;
  tokensOut: number;
};

type NonLlmSpec = {
  tool: string;
  metric: string;
  value: number;
};

type JourneyLog = {
  agent: string;
  customerId: string;
  step: string;
  provider?: string;
  model?: string;
  metric?: string;
};

type AgentDefinition = {
  id: 'support_triage' | 'invoice_recon' | 'compliance_research';
  request: string;
  llms: LlmSpec[];
  nonLlm: NonLlmSpec;
  customers: string[];
};

const agents: AgentDefinition[] = [
  {
    id: 'support_triage',
    request: 'Diagnose a support escalation and draft a concise answer.',
    llms: [
      { provider: Provider.OPENAI, model: 'gpt-4o-mini', tokensIn: 2400, tokensOut: 900 },
      { provider: Provider.GOOGLE, model: 'gemini-1.5-flash', tokensIn: 1200, tokensOut: 450 },
    ],
    nonLlm: { tool: 'vector-search', metric: 'vector_queries', value: 12 },
    customers: ['support_alpha', 'support_beta', 'support_gamma'],
  },
  {
    id: 'invoice_recon',
    request: 'Reconcile a disputed invoice and identify billable usage.',
    llms: [
      { provider: Provider.ANTHROPIC, model: 'claude-3-5-sonnet', tokensIn: 2000, tokensOut: 1100 },
      { provider: Provider.DEEPSEEK, model: 'deepseek-chat', tokensIn: 1600, tokensOut: 800 },
    ],
    nonLlm: { tool: 'document-ocr', metric: 'ocr_pages', value: 9 },
    customers: ['invoice_delta', 'invoice_echo', 'invoice_foxtrot'],
  },
  {
    id: 'compliance_research',
    request: 'Research a compliance question and prepare cited risk notes.',
    llms: [
      { provider: Provider.MISTRAL, model: 'mistral-large-latest', tokensIn: 1800, tokensOut: 750 },
      { provider: Provider.COHERE, model: 'command-r-plus', tokensIn: 1400, tokensOut: 650 },
      { provider: Provider.OTHER, model: 'llama-3.1-70b', tokensIn: 2200, tokensOut: 900 },
    ],
    nonLlm: { tool: 'web-search', metric: 'web_search_results', value: 45 },
    customers: ['compliance_golf', 'compliance_hotel', 'compliance_india'],
  },
];

const allCustomerIds = agents.flatMap((agent) => agent.customers);

const JourneyState = Annotation.Root({
  agentId: Annotation<string>(),
  customerId: Annotation<string>(),
  request: Annotation<string>(),
  answer: Annotation<string>(),
  logs: Annotation<JourneyLog[]>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

let sql: ReturnType<typeof postgres>;
let builderId = '';
let budgetRuleId = '';
let lastIngestResponse: IngestResponse | null = null;
let fetchSpy: { mockRestore: () => void } | null = null;

function recordLlm(spec: LlmSpec, agent: AgentDefinition, step: string): string {
  const ctx = currentContext();
  if (!ctx) throw new Error('recordLlm must run inside pylva.track()');
  enqueue({
    run_id: ctx.run_id,
    parent_run_id: ctx.parent_run_id,
    trace_id: ctx.trace_id,
    span_id: crypto.randomUUID(),
    parent_span_id: ctx.span_id,
    customer_id: ctx.customer_id,
    step_name: ctx.step_name ?? `${agent.id}:${step}`,
    model: spec.model,
    provider: spec.provider,
    tokens_in: spec.tokensIn,
    tokens_out: spec.tokensOut,
    latency_ms: 100 + spec.tokensOut,
    tool_name: null,
    status: EventStatus.SUCCESS,
    framework: ctx.framework ?? Framework.NONE,
    instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    cost_source: CostSource.AUTO,
    metric: null,
    metric_value: null,
    stream_aborted: false,
    abort_savings_usd: 0,
    timestamp: new Date().toISOString(),
    metadata: { token_count_source: TokenCountSource.EXACT },
  });
  return `${spec.provider}/${spec.model}`;
}

function createAgentGraph(agent: AgentDefinition) {
  const classify = async (state: typeof JourneyState.State) =>
    track(state.customerId, { step: `${agent.id}:classify`, framework: Framework.LANGGRAPH }, () => {
      const model = recordLlm(agent.llms[0]!, agent, 'classify');
      return {
        answer: `classified:${state.request}`,
        logs: [{ agent: agent.id, customerId: state.customerId, step: 'classify', model }],
      };
    });

  const retrieve = async (state: typeof JourneyState.State) =>
    track(state.customerId, { step: `${agent.id}:retrieve`, framework: Framework.LANGGRAPH }, () => {
      reportUsage({
        tool: agent.nonLlm.tool,
        metric: agent.nonLlm.metric,
        value: agent.nonLlm.value,
      });
      reportUsage({ tool: 'credit-meter', metric: 'credits', value: 35 });
      return {
        logs: [
          {
            agent: agent.id,
            customerId: state.customerId,
            step: 'retrieve',
            metric: agent.nonLlm.metric,
          },
          { agent: agent.id, customerId: state.customerId, step: 'credits', metric: 'credits' },
        ],
      };
    });

  const solve = async (state: typeof JourneyState.State) =>
    track(state.customerId, { step: `${agent.id}:solve`, framework: Framework.LANGGRAPH }, () => {
      const logs: JourneyLog[] = [];
      for (const spec of agent.llms.slice(1)) {
        logs.push({
          agent: agent.id,
          customerId: state.customerId,
          step: 'solve',
          provider: spec.provider,
          model: spec.model,
        });
        recordLlm(spec, agent, 'solve');
      }
      return {
        answer: `${state.answer}:solved`,
        logs,
      };
    });

  const finalize = async (state: typeof JourneyState.State) => ({
    answer: `${state.answer}:final`,
    logs: [{ agent: agent.id, customerId: state.customerId, step: 'finalize' }],
  });

  return new StateGraph(JourneyState)
    .addNode('classify', classify)
    .addNode('retrieve', retrieve)
    .addNode('solve', solve)
    .addNode('finalize', finalize)
    .addEdge(START, 'classify')
    .addEdge('classify', 'retrieve')
    .addEdge('retrieve', 'solve')
    .addEdge('solve', 'finalize')
    .addEdge('finalize', END)
    .compile();
}

async function createBuilder(): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (
      ${`langgraph-sdk-e2e-${suffix}@example.com`},
      'LangGraph SDK E2E Readiness',
      'pro',
      ${`langgraph-sdk-e2e-${suffix}`}
    )
    RETURNING id
  `;
  return row!.id;
}

async function installPricing(id: string): Promise<void> {
  const llmRows = [
    [Provider.OPENAI, 'gpt-4o-mini', 1.1, 4.4],
    [Provider.GOOGLE, 'gemini-1.5-flash', 0.35, 1.05],
    [Provider.ANTHROPIC, 'claude-3-5-sonnet', 3.0, 15.0],
    [Provider.DEEPSEEK, 'deepseek-chat', 0.27, 1.1],
    [Provider.MISTRAL, 'mistral-large-latest', 2.0, 6.0],
    [Provider.COHERE, 'command-r-plus', 2.5, 10.0],
    [Provider.OTHER, 'llama-3.1-70b', 0.6, 0.8],
  ] as const;

  for (const [provider, model, inputPer1m, outputPer1m] of llmRows) {
    await sql`
      INSERT INTO custom_pricing (
        builder_id, provider, model, metric, price_per_unit_usd,
        input_per_1m_usd, output_per_1m_usd, effective_from, source
      ) VALUES (
        ${id}, ${provider}, ${model}, NULL, 0.000001,
        ${inputPer1m}, ${outputPer1m}, NOW() - INTERVAL '1 day', 'builder_manual'
      )
    `;
  }

  await sql`
    INSERT INTO custom_pricing (
      builder_id, provider, model, metric, price_per_unit_usd,
      effective_from, source
    ) VALUES
      (${id}, NULL, NULL, 'vector_queries', 0.03, NOW() - INTERVAL '1 day', 'builder_manual'),
      (${id}, NULL, NULL, 'credits', 0.01, NOW() - INTERVAL '1 day', 'builder_manual')
  `;

  await sql`
    INSERT INTO cost_sources (
      builder_id, source_type, display_name, slug, metric, unit, price_per_unit, pricing_tiers,
      approved_at
    ) VALUES
      (${id}, 'non_llm_manual', 'Document OCR', 'document-ocr', 'ocr_pages', 'page', 0.12, NULL, NOW()),
      (
        ${id}, 'non_llm_manual', 'Web Search', 'web-search', 'web_search_results', 'result', NULL,
        ${sql.json([
          { from: 0, to: 25, price: 0.01 },
          { from: 25, to: null, price: 0.006 },
        ])},
        NOW()
      )
  `;
}

async function installBudgetRule(id: string): Promise<void> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO rules (
      builder_id, type, enforcement, name, enabled, config, customer_id, status, activated_at
    ) VALUES (
      ${id}, 'budget_limit', 'pre_call', 'support_alpha hard stop', true,
      ${sql.json({
        limit_usd: 0.01,
        period: 'day',
        hard_stop: true,
        scope: 'per_customer',
      })},
      'support_alpha', 'active', NOW()
    )
    RETURNING id
  `;
  budgetRuleId = row!.id;
}

function sdkRules() {
  return [
    {
      id: budgetRuleId,
      type: 'budget_limit',
      enabled: true,
      customer_id: 'support_alpha',
      config: {
        limit_usd: 0.01,
        period: 'day',
        hard_stop: true,
        scope: 'per_customer',
      },
    },
  ];
}

function installSdkFetchMock(): void {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (href === `${SDK_ENDPOINT}/api/v1/rules`) {
      return new Response(JSON.stringify({ rules: sdkRules() }), { status: 200 });
    }
    if (href === `${SDK_ENDPOINT}/api/v1/budget/sync`) {
      return new Response(JSON.stringify({ entries: [] }), { status: 200 });
    }
    if (href === `${SDK_ENDPOINT}/api/v1/events`) {
      const response = await handleTelemetryIngest({
        builderId,
        keyId: 'sdk-e2e-key',
        rawBody: String(init?.body ?? ''),
      });
      lastIngestResponse = JSON.parse(response.body) as IngestResponse;
      return new Response(response.body, { status: response.status });
    }
    return new Response('not found', { status: 404 });
  });
}

async function runAgents(): Promise<JourneyLog[]> {
  const logs: JourneyLog[] = [];
  for (const agent of agents) {
    const graph = createAgentGraph(agent);
    for (const customerId of agent.customers) {
      const result = await graph.invoke({
        agentId: agent.id,
        customerId,
        request: agent.request,
        answer: '',
      });
      expect(result.answer.endsWith(':final')).toBe(true);
      logs.push(...result.logs);
    }
  }
  return logs;
}

async function clickhouseRows(id: string): Promise<
  Array<{
    provider: string;
    model: string | null;
    metric: string | null;
    customer_id: string;
    cost_usd: string | null;
    pricing_status: string;
    metadata: string;
  }>
> {
  const result = await clickhouse.query({
    query: `
      SELECT provider, model, metric, customer_id, cost_usd, pricing_status, metadata
        FROM cost_events
       WHERE builder_id = {builder:String}
       ORDER BY customer_id, timestamp, span_id
    `,
    query_params: { builder: id },
    format: 'JSONEachRow',
  });
  return (await result.json()) as Array<{
    provider: string;
    model: string | null;
    metric: string | null;
    customer_id: string;
    cost_usd: string | null;
    pricing_status: string;
    metadata: string;
  }>;
}

async function installCustomerPricing(id: string): Promise<Map<string, string>> {
  const rows = await sql<{ id: string; external_id: string }[]>`
    SELECT id, external_id
      FROM customers
     WHERE builder_id = ${id}
  `;
  const byExternalId = new Map(rows.map((row) => [row.external_id, row.id]));

  for (const customerId of agents[0]!.customers) {
    await sql`
      INSERT INTO customer_pricing (
        builder_id, customer_id, pricing_model, per_unit_rates, markup_pct,
        billing_period, version, effective_from
      ) VALUES (
        ${id}, ${byExternalId.get(customerId)!}, 'pay_as_you_go',
        ${sql.json({
          input_tokens: 0.00001,
          output_tokens: 0.00002,
          vector_queries: 0.08,
          credits: 0.02,
        })},
        10, 'monthly', 1, NOW() - INTERVAL '1 day'
      )
    `;
  }

  for (const customerId of agents[1]!.customers) {
    await sql`
      INSERT INTO customer_pricing (
        builder_id, customer_id, pricing_model, pack_price_usd, included_credits,
        overage_rate_usd, billing_period, version, effective_from
      ) VALUES (
        ${id}, ${byExternalId.get(customerId)!}, 'credit_pack', 5.00, 20,
        0.15, 'monthly', 1, NOW() - INTERVAL '1 day'
      )
    `;
  }

  for (const customerId of agents[2]!.customers) {
    await sql`
      INSERT INTO customer_pricing (
        builder_id, customer_id, pricing_model, base_fee_usd, included_credits,
        overage_rate_usd, billing_period, version, effective_from
      ) VALUES (
        ${id}, ${byExternalId.get(customerId)!}, 'hybrid', 10.00, 25,
        0.2, 'monthly', 1, NOW() - INTERVAL '1 day'
      )
    `;
  }

  return byExternalId;
}

async function previewFor(customerUuid: string, proposed: unknown) {
  const previewUrl = new URL('http://localhost/api/v1/billing/pricing/preview');
  previewUrl.searchParams.set('customer_id', customerUuid);
  previewUrl.searchParams.set('proposed', Buffer.from(JSON.stringify(proposed)).toString('base64'));
  const response = await pricingPreview(
    new NextRequest(previewUrl, {
      headers: { 'x-builder-id': builderId },
    } as ConstructorParameters<typeof NextRequest>[1]),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as {
    current: { amount_usd: number; line_items: Array<{ metric: string; quantity: number }> };
    proposed: { amount_usd: number; line_items: Array<{ metric: string; quantity: number }> };
    delta_usd: number;
  };
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  builderId = await createBuilder();
  await installPricing(builderId);
  await installBudgetRule(builderId);
});

beforeEach(() => {
  lastIngestResponse = null;
  resetPricingCaches();
  resetCostSourcePricingCache();
  fetchSpy?.mockRestore();
  fetchSpy = null;
  installSdkFetchMock();
});

afterAll(async () => {
  fetchSpy?.mockRestore();
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

describe('TypeScript SDK + LangGraph customer journey launch readiness', () => {
  it('discovers, tracks, reacts, and previews billing for 3 LangGraph agents x 3 customers', async () => {
    init({ apiKey: SDK_KEY, endpoint: SDK_ENDPOINT, batchSize: 1000, flushInterval: 60_000 });

    const logs = await runAgents();
    expect(logs.filter((log) => log.step === 'finalize')).toHaveLength(9);

    await flush();

    expect(lastIngestResponse).toMatchObject({ accepted: 39, rejected: 0 });
    expect(lastIngestResponse?.warnings).toBeUndefined();
    expect(lastIngestResponse?.budget_exceeded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule_id: budgetRuleId,
          customer_id: 'support_alpha',
        }),
      ]),
    );

    const pgCustomers = await sql<{ external_id: string }[]>`
      SELECT external_id
        FROM customers
       WHERE builder_id = ${builderId}
       ORDER BY external_id
    `;
    expect(pgCustomers.map((row) => row.external_id)).toEqual([...allCustomerIds].sort());

    const rows = await clickhouseRows(builderId);
    expect(rows).toHaveLength(39);
    expect(rows.every((row) => row.customer_id.startsWith(`${builderId}:`))).toBe(true);
    expect(rows.every((row) => row.pricing_status === 'priced')).toBe(true);
    expect(rows.every((row) => Number(row.cost_usd) >= 0)).toBe(true);
    expect(new Set(rows.map((row) => JSON.parse(row.metadata).framework))).toEqual(
      new Set([Framework.LANGGRAPH]),
    );
    expect(new Set(rows.filter((row) => row.model).map((row) => row.provider))).toEqual(
      new Set([
        Provider.OPENAI,
        Provider.GOOGLE,
        Provider.ANTHROPIC,
        Provider.DEEPSEEK,
        Provider.MISTRAL,
        Provider.COHERE,
        Provider.OTHER,
      ]),
    );
    expect(new Set(rows.filter((row) => row.metric).map((row) => row.metric))).toEqual(
      new Set(['vector_queries', 'ocr_pages', 'web_search_results', 'credits']),
    );

    const range = {
      from: new Date(Date.now() - 60 * 60 * 1000),
      to: new Date(Date.now() + 60 * 60 * 1000),
    };
    const overview = await getOverview(builderId, range, {
      includeDemo: false,
      hasRealEvents: true,
    });
    expect(overview.event_count).toBe(39);
    expect(overview.customer_count).toBe(9);
    expect(overview.total_spend_usd).toBeGreaterThan(0);

    const summaries = await getCustomerCostSummary(builderId, range, { includeDemo: false });
    expect(summaries).toHaveLength(9);
    expect(summaries.every((summary) => summary.total_spend_usd > 0)).toBe(true);

    const supportUsage = await getUsageForPeriod({
      builderId,
      customerId: toCompositeCustomerId(builderId, 'support_alpha'),
      from: range.from,
      to: range.to,
    });
    expect(supportUsage.by_metric.input_tokens).toBeGreaterThan(0);
    expect(supportUsage.by_metric.output_tokens).toBeGreaterThan(0);
    expect(supportUsage.by_metric.vector_queries).toBe(12);
    expect(supportUsage.by_metric.credits).toBe(35);
    expect(supportUsage.has_unpriced).toBe(false);

    const customerUuids = await installCustomerPricing(builderId);
    const supportPreview = await previewFor(customerUuids.get('support_alpha')!, {
      pricing_model: 'pay_as_you_go',
      per_unit_rates: {
        input_tokens: 0.00002,
        output_tokens: 0.00004,
        vector_queries: 0.1,
        credits: 0.03,
      },
      markup_pct: 10,
      billing_period: 'monthly',
    });
    expect(supportPreview.proposed.amount_usd).toBeGreaterThan(supportPreview.current.amount_usd);

    const creditPreview = await previewFor(customerUuids.get('invoice_delta')!, {
      pricing_model: 'credit_pack',
      pack_price_usd: 7,
      included_credits: 20,
      overage_rate_usd: 0.2,
      billing_period: 'monthly',
    });
    expect(creditPreview.current.line_items.map((line) => line.metric)).toContain('overage');
    expect(creditPreview.proposed.amount_usd).toBeGreaterThan(creditPreview.current.amount_usd);

    const hybridPreview = await previewFor(customerUuids.get('compliance_golf')!, {
      pricing_model: 'hybrid',
      base_fee_usd: 12,
      included_credits: 25,
      overage_rate_usd: 0.25,
      billing_period: 'monthly',
    });
    expect(hybridPreview.current.line_items.map((line) => line.metric)).toEqual(
      expect.arrayContaining(['base', 'overage']),
    );
    expect(hybridPreview.proposed.amount_usd).toBeGreaterThan(hybridPreview.current.amount_usd);
  }, 120_000);
});
