// Real authoritative-control fixture for Playwright.
//
// Unlike the layout seed, this file never inserts a synthetic cost event. It
// uses the production reservation, frozen-pricing settlement, outbox, and
// projection services. A tiny in-process provider double proves that denied
// actions do not dispatch; it returns usage only, never content.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import * as v from 'valibot';
import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  ReserveUsageRequestSchema,
  type ParsedCommitUsageRequest,
  type ParsedReserveUsageRequest,
} from '@pylva/shared';
import {
  createBudgetControlCutover,
  markBudgetControlReady,
} from '../../../src/lib/budget-control/readiness.js';
import { reconcileBudgetRuleRevisionInTransaction } from '../../../src/lib/budget-control/rule-revisions.js';
import { createReserveBudgetUsage } from '../../../src/lib/budget-control/reservation-service.js';
import { createBudgetLifecycleService } from '../../../src/lib/budget-control/lifecycle-service.js';
import { resolveBudgetControlDatabaseConfig } from '../../../src/lib/budget-control/database-config.js';
import { withBudgetBuilderTransaction } from '../../../src/lib/budget-control/transaction.js';
import { DASHBOARD_ORG_SLUG } from './fixtures.js';
import { AUTHORITATIVE_E2E } from './authoritative-budget-journey-fixtures.js';

const DEFAULT_DATABASE_URL = 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const SDK_IDENTITY = { sdkVersion: '1.2.0', sdkLanguage: 'typescript' } as const;

interface AuthoritySnapshot {
  actualUsd: string;
  outbox: string;
  usage: string;
}

interface LegacyBillingSnapshot {
  invoices: string;
  invoiceUsd: string;
}

interface JourneySnapshot extends AuthoritySnapshot, LegacyBillingSnapshot {}

function requireEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function useBuilder(transaction: TransactionSql, builderId: string): Promise<void> {
  await transaction`SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)`;
}

async function configureRule(client: Sql, builderId: string): Promise<void> {
  await withBudgetBuilderTransaction(
    builderId,
    'exclusive',
    async (transaction) => {
      await transaction`
        INSERT INTO public.rules (
          id, builder_id, type, enforcement, name, enabled, config, status
        ) VALUES (
          ${AUTHORITATIVE_E2E.ruleId}::UUID,
          ${builderId}::UUID,
          'budget_limit',
          'pre_call',
          ${AUTHORITATIVE_E2E.ruleName},
          TRUE,
          ${JSON.stringify({
            scope: 'pooled',
            period: 'day',
            hard_stop: true,
            limit_usd: Number(AUTHORITATIVE_E2E.budgetLimitUsd),
          })}::TEXT::JSONB,
          'active'
        )
        ON CONFLICT (id) DO UPDATE SET
          name = EXCLUDED.name,
          enabled = EXCLUDED.enabled,
          config = EXCLUDED.config,
          status = EXCLUDED.status,
          enforcement = EXCLUDED.enforcement,
          updated_at = pg_catalog.transaction_timestamp()
        WHERE public.rules.builder_id = EXCLUDED.builder_id
      `;
      const revision = await reconcileBudgetRuleRevisionInTransaction(
        transaction,
        builderId,
        AUTHORITATIVE_E2E.ruleId,
      );
      if (revision.action !== 'created' && revision.action !== 'unchanged') {
        throw new Error(`unexpected authoritative rule reconciliation: ${revision.action}`);
      }
    },
    { client, maxAttempts: 1 },
  );
}

async function configureToolPricing(client: Sql, builderId: string): Promise<void> {
  await client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    await transaction`
      INSERT INTO public.cost_sources (
        builder_id, source_type, display_name, slug, metric, unit,
        price_per_unit, pricing_tiers, status, approved_at, tracking_status
      ) VALUES (
        ${builderId}::UUID, 'non_llm_manual', 'Tavily Search',
        'tavily-search', 'credit', 'credit', 0.000004, NULL,
        'healthy', pg_catalog.transaction_timestamp(), 'tracked'
      )
      ON CONFLICT (builder_id, slug) DO UPDATE SET
        source_type = EXCLUDED.source_type,
        display_name = EXCLUDED.display_name,
        metric = EXCLUDED.metric,
        unit = EXCLUDED.unit,
        price_per_unit = EXCLUDED.price_per_unit,
        pricing_tiers = EXCLUDED.pricing_tiers,
        status = EXCLUDED.status,
        approved_at = EXCLUDED.approved_at,
        tracking_status = EXCLUDED.tracking_status
    `;
  });
}

function request(
  input:
    | {
        kind: 'llm';
        operationId: string;
        spanId: string;
        stepName: string;
        traceId: string;
        customerId: string;
      }
    | {
        kind: 'tool';
        operationId: string;
        spanId: string;
        stepName: string;
        traceId: string;
        customerId: string;
        maximumValue?: string;
      },
): ParsedReserveUsageRequest {
  const common = {
    schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
    mode: 'enforce',
    operation_id: input.operationId,
    customer_id: input.customerId,
    trace_id: input.traceId,
    span_id: input.spanId,
    parent_span_id: null,
    step_name: input.stepName,
    framework: 'langgraph',
    reservation_ttl_seconds: 300,
  } as const;
  return v.parse(
    ReserveUsageRequestSchema,
    input.kind === 'llm'
      ? {
          ...common,
          kind: 'llm',
          provider: 'openai',
          model: 'gpt-4o-mini',
          estimated_input_tokens: 1_000,
          max_output_tokens: 1_000,
        }
      : {
          ...common,
          kind: 'tool',
          cost_source_slug: 'tavily-search',
          tool_name: 'tavily_search',
          metric: 'credit',
          maximum_value: input.maximumValue ?? '1',
        },
  );
}

async function authoritySnapshot(client: Sql, builderId: string): Promise<AuthoritySnapshot> {
  return client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const rows = await transaction<AuthoritySnapshot[]>`
      SELECT
        (SELECT COUNT(*)::TEXT FROM public.budget_usage_ledger
          WHERE builder_id = ${builderId}::UUID) AS usage,
        (SELECT COUNT(*)::TEXT FROM public.budget_cost_event_outbox
          WHERE builder_id = ${builderId}::UUID) AS outbox,
        (SELECT COALESCE(SUM(actual_cost_usd), 0)::TEXT FROM public.budget_usage_ledger
          WHERE builder_id = ${builderId}::UUID) AS "actualUsd"
    `;
    const row = rows[0];
    if (!row) throw new Error('authoritative fixture snapshot returned no row');
    return row;
  }) as Promise<AuthoritySnapshot>;
}

async function legacyBillingSnapshot(
  client: Sql,
  builderId: string,
): Promise<LegacyBillingSnapshot> {
  return client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const rows = await transaction<LegacyBillingSnapshot[]>`
      SELECT
        COUNT(*)::TEXT AS invoices,
        COALESCE(SUM(amount_usd), 0)::TEXT AS "invoiceUsd"
      FROM public.invoices
      WHERE builder_id = ${builderId}::UUID
    `;
    const row = rows[0];
    if (!row) throw new Error('legacy billing fixture snapshot returned no row');
    return row;
  }) as Promise<LegacyBillingSnapshot>;
}

async function journeySnapshot(
  budgetClient: Sql,
  generalClient: Sql,
  builderId: string,
): Promise<JourneySnapshot> {
  const [authority, legacyBilling] = await Promise.all([
    authoritySnapshot(budgetClient, builderId),
    legacyBillingSnapshot(generalClient, builderId),
  ]);
  return { ...authority, ...legacyBilling };
}

async function committedPrimaryOperationCount(client: Sql, builderId: string): Promise<number> {
  return client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const rows = await transaction<Array<{ count: string }>>`
      SELECT COUNT(*)::TEXT AS count
      FROM public.budget_reservations
      WHERE builder_id = ${builderId}::UUID
        AND operation_id IN (
          ${AUTHORITATIVE_E2E.operations.llm}::UUID,
          ${AUTHORITATIVE_E2E.operations.tool}::UUID
        )
        AND state = 'committed'
    `;
    const count = Number(rows[0]?.count);
    if (!Number.isSafeInteger(count) || count < 0 || count > 2) {
      throw new Error('existing primary operation count is invalid');
    }
    return count;
  }) as Promise<number>;
}

async function reservationState(
  client: Sql,
  builderId: string,
  reservationId: string,
): Promise<string> {
  return client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const rows = await transaction<Array<{ state: string }>>`
      SELECT state
      FROM public.budget_reservations
      WHERE builder_id = ${builderId}::UUID
        AND reservation_id = ${reservationId}::UUID
    `;
    if (rows.length !== 1 || typeof rows[0]?.state !== 'string') {
      throw new Error('reserved fixture operation has no unique durable state');
    }
    return rows[0].state;
  }) as Promise<string>;
}

async function assertJourneyRows(client: Sql, builderId: string): Promise<void> {
  await client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const primary = await transaction<Array<{ charged: string; refused: string; total: string }>>`
      SELECT
        COUNT(*)::TEXT AS total,
        COUNT(*) FILTER (WHERE state = 'committed')::TEXT AS charged,
        COUNT(*) FILTER (WHERE decision = 'denied')::TEXT AS refused
      FROM public.budget_reservations
      WHERE builder_id = ${builderId}::UUID
        AND trace_id = ${AUTHORITATIVE_E2E.primaryTraceId}::UUID
    `;
    requireEqual(
      primary[0]?.total,
      String(AUTHORITATIVE_E2E.expected.primaryActions),
      'primary trace action count',
    );
    requireEqual(
      primary[0]?.charged,
      String(AUTHORITATIVE_E2E.expected.primaryCharged),
      'primary trace charged count',
    );
    requireEqual(
      primary[0]?.refused,
      String(AUTHORITATIVE_E2E.expected.primaryRefused),
      'primary trace refusal count',
    );

    const usage = await transaction<Array<{ actual_usd: string; kind: string }>>`
      SELECT kind, public.pylva_budget_decimal_text(actual_cost_usd) AS actual_usd
      FROM public.budget_usage_ledger
      WHERE builder_id = ${builderId}::UUID
        AND trace_id = ${AUTHORITATIVE_E2E.primaryTraceId}::UUID
      ORDER BY kind ASC
    `;
    requireEqual(usage.length, 2, 'authoritative primary-trace usage count');
    requireEqual(usage[0]?.kind, 'llm', 'first authoritative usage kind');
    requireEqual(usage[0]?.actual_usd, AUTHORITATIVE_E2E.expected.llmActualUsd, 'LLM actual cost');
    requireEqual(usage[1]?.kind, 'tool', 'second authoritative usage kind');
    requireEqual(
      usage[1]?.actual_usd,
      AUTHORITATIVE_E2E.expected.toolActualUsd,
      'tool actual cost',
    );
  });
}

async function assertProjection(client: Sql, builderId: string): Promise<void> {
  // The worker imports the application logger/config. Load it only after main
  // has installed safe local defaults for standalone fixture execution.
  const [{ createBudgetProjectionPostgresStore }, { runBudgetCostEventProjection }] =
    await Promise.all([
      import('../../../src/lib/budget-projection/postgres.js'),
      import('../../../src/lib/budget-projection/worker.js'),
    ]);
  const result = await runBudgetCostEventProjection(
    {
      builderConcurrency: 1,
      claimLimit: 10,
      eventConcurrency: 2,
      reconciliationLimit: 10,
    },
    { store: createBudgetProjectionPostgresStore(client) },
  );
  if (
    result.errors !== 0 ||
    result.retry_scheduled !== 0 ||
    result.projection_conflicts !== 0 ||
    result.invalid_payloads !== 0 ||
    result.pending_rows !== 0 ||
    result.processing_rows !== 0 ||
    result.projected_unverified_rows !== 0
  ) {
    throw new Error(
      `authoritative projection did not reconcile cleanly: ${JSON.stringify(result)}`,
    );
  }

  await client.begin(async (transaction) => {
    await useBuilder(transaction, builderId);
    const rows = await transaction<Array<{ projected: string; verified: string }>>`
      SELECT
        COUNT(*) FILTER (WHERE status = 'projected')::TEXT AS projected,
        COUNT(*) FILTER (
          WHERE status = 'projected' AND projection_verified_at IS NOT NULL
        )::TEXT AS verified
      FROM public.budget_cost_event_outbox
      WHERE builder_id = ${builderId}::UUID
        AND cost_event_id IN (
          SELECT cost_event_id
          FROM public.budget_usage_ledger
          WHERE builder_id = ${builderId}::UUID
            AND trace_id = ${AUTHORITATIVE_E2E.primaryTraceId}::UUID
        )
    `;
    requireEqual(rows[0]?.projected, '2', 'projected authoritative events');
    requireEqual(rows[0]?.verified, '2', 'verified authoritative events');
  });
}

async function main(): Promise<void> {
  process.env.DATABASE_URL ??= DEFAULT_DATABASE_URL;
  process.env.CLICKHOUSE_URL ??= 'http://localhost:8123';
  process.env.BUDGET_PROJECTION_CLICKHOUSE_URL ??= process.env.CLICKHOUSE_URL;
  process.env.ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK ??= 'true';
  process.env.REDIS_URL ??= 'redis://localhost:6379';
  process.env.JWT_PRIVATE_KEY ??= '/tmp/pylva-e2e-private.pem';
  process.env.JWT_PUBLIC_KEY ??= '/tmp/pylva-e2e-public.pem';
  process.env.ARGON2_SECRET ??= 'authoritative-e2e-test-secret-32-bytes';

  const generalDatabaseUrl = process.env.DATABASE_URL;
  const budgetControlDatabase = resolveBudgetControlDatabaseConfig({
    ...process.env,
    DATABASE_URL: generalDatabaseUrl,
    // The real journey is a credential-boundary proof. It must never use the
    // local fallback even if the surrounding shell enables it for other tests.
    ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'false',
  });
  const generalClient = postgres(generalDatabaseUrl, { max: 4, onnotice: () => undefined });
  const budgetClient = postgres(budgetControlDatabase.databaseUrl, {
    max: 8,
    onnotice: () => undefined,
  });
  try {
    const builders = await generalClient<{ id: string }[]>`
      SELECT id::TEXT AS id
      FROM public.builders
      WHERE slug = ${DASHBOARD_ORG_SLUG}
      LIMIT 1
    `;
    const builderId = builders[0]?.id;
    if (!builderId) {
      throw new Error(`builder "${DASHBOARD_ORG_SLUG}" not found; run pnpm db:seed first`);
    }

    // The cutover intentionally precedes the first budget revision. That makes
    // a zero opening balance authoritative without fabricating a backfill.
    await createBudgetControlCutover(builderId, 'next_period', {
      client: budgetClient,
      maxAttempts: 1,
    });
    await markBudgetControlReady(builderId, { client: budgetClient, maxAttempts: 1 });
    await configureRule(budgetClient, builderId);
    await configureToolPricing(generalClient, builderId);

    const reserve = createReserveBudgetUsage({
      client: budgetClient,
      controlEnabled: () => true,
      maxAttempts: 1,
      sleep: async () => undefined,
    });
    const lifecycle = createBudgetLifecycleService({
      transactionOptions: { client: budgetClient, maxAttempts: 1 },
    });
    const existingCommitted = await committedPrimaryOperationCount(budgetClient, builderId);
    const expectedProviderCalls = 2 - existingCommitted;
    let providerCalls = 0;

    const runPaidAction = async (
      reserveRequest: ParsedReserveUsageRequest,
      actualUsage: ParsedCommitUsageRequest,
    ) => {
      const decision = await reserve(builderId, reserveRequest, SDK_IDENTITY);
      if (decision.decision !== 'reserved') return decision;
      const state = await reservationState(budgetClient, builderId, decision.reservation_id);
      if (state === 'committed') return decision;
      if (state !== 'reserved') {
        throw new Error(`allowed fixture reservation has unexpected durable state: ${state}`);
      }
      providerCalls += 1;
      await lifecycle.commitBudgetUsage(
        builderId,
        decision.reservation_id,
        actualUsage,
        SDK_IDENTITY,
      );
      return decision;
    };

    const llmDecision = await runPaidAction(
      request({
        kind: 'llm',
        operationId: AUTHORITATIVE_E2E.operations.llm,
        spanId: AUTHORITATIVE_E2E.spans.llm,
        stepName: AUTHORITATIVE_E2E.steps.llm,
        traceId: AUTHORITATIVE_E2E.primaryTraceId,
        customerId: AUTHORITATIVE_E2E.customerId,
      }),
      {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        status: 'success',
        latency_ms: 38,
        stream_aborted: false,
        kind: 'llm',
        actual_input_tokens: 600,
        actual_output_tokens: 200,
      },
    );
    requireEqual(llmDecision.decision, 'reserved', 'LLM authorization');

    const toolDecision = await runPaidAction(
      request({
        kind: 'tool',
        operationId: AUTHORITATIVE_E2E.operations.tool,
        spanId: AUTHORITATIVE_E2E.spans.tool,
        stepName: AUTHORITATIVE_E2E.steps.tool,
        traceId: AUTHORITATIVE_E2E.primaryTraceId,
        customerId: AUTHORITATIVE_E2E.customerId,
      }),
      {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        status: 'success',
        latency_ms: 21,
        stream_aborted: false,
        kind: 'tool',
        actual_value: '1',
      },
    );
    requireEqual(toolDecision.decision, 'reserved', 'tool authorization');
    requireEqual(providerCalls, expectedProviderCalls, 'allowed provider invocation count');

    const beforeRefusal = await journeySnapshot(budgetClient, generalClient, builderId);
    const refused = await runPaidAction(
      request({
        kind: 'llm',
        operationId: AUTHORITATIVE_E2E.operations.refused,
        spanId: AUTHORITATIVE_E2E.spans.refused,
        stepName: AUTHORITATIVE_E2E.steps.refused,
        traceId: AUTHORITATIVE_E2E.primaryTraceId,
        customerId: AUTHORITATIVE_E2E.customerId,
      }),
      {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        status: 'success',
        latency_ms: 1,
        stream_aborted: false,
        kind: 'llm',
        actual_input_tokens: 1,
        actual_output_tokens: 1,
      },
    );
    requireEqual(refused.decision, 'denied', 'next paid action decision');
    requireEqual(providerCalls, expectedProviderCalls, 'provider count after primary refusal');
    requireEqual(
      JSON.stringify(await journeySnapshot(budgetClient, generalClient, builderId)),
      JSON.stringify(beforeRefusal),
      'refusal authority/billing snapshot',
    );

    // A second, separately filtered refusal proves a trace with zero cost spans
    // is still discoverable. It is not part of the three-action primary graph.
    const beforeBlockedOnly = await journeySnapshot(budgetClient, generalClient, builderId);
    const blockedOnly = await runPaidAction(
      request({
        kind: 'tool',
        operationId: AUTHORITATIVE_E2E.operations.blockedOnly,
        spanId: AUTHORITATIVE_E2E.spans.blockedOnly,
        stepName: AUTHORITATIVE_E2E.steps.blockedOnly,
        traceId: AUTHORITATIVE_E2E.blockedOnlyTraceId,
        customerId: AUTHORITATIVE_E2E.blockedOnlyCustomerId,
        maximumValue: '200',
      }),
      {
        schema_version: BUDGET_CONTROL_SCHEMA_VERSION,
        status: 'success',
        latency_ms: 1,
        stream_aborted: false,
        kind: 'tool',
        actual_value: '1',
      },
    );
    requireEqual(blockedOnly.decision, 'denied', 'blocked-only trace decision');
    requireEqual(providerCalls, expectedProviderCalls, 'provider count after blocked-only refusal');
    requireEqual(
      JSON.stringify(await journeySnapshot(budgetClient, generalClient, builderId)),
      JSON.stringify(beforeBlockedOnly),
      'blocked-only refusal authority/billing snapshot',
    );

    await assertJourneyRows(budgetClient, builderId);
    await assertProjection(budgetClient, builderId);
    console.log(
      `  ✓ authoritative journey: 2 charged, 1 primary refusal, 0 denied provider calls, 2 verified projections`,
    );
  } finally {
    await import('../../../src/lib/budget-projection/clickhouse-client.js')
      .then(({ closeBudgetProjectionClickHouse }) => closeBudgetProjectionClickHouse())
      .catch(() => undefined);
    await Promise.all([budgetClient.end(), generalClient.end()]);
  }
}

const direct =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (direct) {
  main().catch((error) => {
    console.error('authoritative budget journey seed failed:', error);
    process.exitCode = 1;
  });
}
