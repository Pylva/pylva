import crypto from 'node:crypto';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { controlledTavilySearch } from '../../packages/sdk-ts/src/adapters/tavily.js';
import {
  _resetConfigForTests,
  ControlMode,
  ControlUnavailablePolicy,
  init,
} from '../../packages/sdk-ts/src/core/config.js';
import { _resetControlClientForTests } from '../../packages/sdk-ts/src/core/control_client.js';
import { PylvaBudgetExceeded } from '../../packages/sdk-ts/src/errors/budget_exceeded.js';
import {
  createBudgetControlHttpHandler,
  type BudgetControlServiceContext,
} from '../../src/lib/budget-control/http-handler.js';
import { createBudgetLifecycleService } from '../../src/lib/budget-control/lifecycle-service.js';
import { createReserveBudgetUsage } from '../../src/lib/budget-control/reservation-service.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

const SDK_IDENTITY = { sdkVersion: '1.2.0', sdkLanguage: 'typescript' as const };
const SDK_KEY = `pv_live_aabbccdd_${'a'.repeat(32)}`;
const CONTROL_ENDPOINT = 'https://tavily-control.integration';
const UNIT_PRICE_USD = '0.125';

type JsonObject = Record<string, postgres.JSONValue | undefined>;

interface BuilderFixture {
  builderId: string;
  ruleKey: string;
}

interface BackendHarness {
  bodies: string[];
  fetch: ReturnType<typeof vi.fn>;
}

let scratch: ScratchDb | undefined;

function db(): Sql {
  if (!scratch) throw new Error('Tavily pricing scratch database is unavailable');
  return scratch.sql;
}

async function useBuilder(tx: TransactionSql, builderId: string): Promise<void> {
  await tx`SELECT pg_catalog.set_config('app.builder_id', ${builderId}, true)`;
}

async function jsonHash(tx: TransactionSql, value: JsonObject): Promise<string> {
  const rows = await tx<{ value: string }[]>`
    SELECT public.pylva_budget_jsonb_sha256(${tx.json(value)}::JSONB) AS value
  `;
  const hash = rows[0]?.value;
  if (!hash) throw new Error('fixture JSON hash was unavailable');
  return hash;
}

async function withBuilder<T>(
  builderId: string,
  callback: (tx: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await db().begin(async (tx) => {
    await useBuilder(tx, builderId);
    return callback(tx);
  })) as T;
}

async function seedControlledBuilder(limitUsd: string): Promise<BuilderFixture> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const builders = await db()<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`tavily-pricing-${suffix}@example.com`}, 'Tavily pricing integration', 'pro',
      ${`tavily-pricing-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  const builderId = builders[0]?.id;
  if (!builderId) throw new Error('builder insert returned no identity');

  const ruleKey = crypto.randomUUID();
  await withBuilder(builderId, async (tx) => {
    const cutovers = await tx<{ cutover_at: string }[]>`
      INSERT INTO public.budget_control_cutovers (builder_id, status, mode)
      VALUES (${builderId}::UUID, 'pending', 'exact_backfill')
      RETURNING public.pylva_budget_timestamp_text(cutover_at) AS cutover_at
    `;
    const cutoverAt = cutovers[0]?.cutover_at;
    if (!cutoverAt) throw new Error('cutover insert returned no watermark');
    const reconciliationSnapshot: JsonObject = {
      schema_version: '1.0',
      builder_id: builderId,
      mode: 'exact_backfill',
      cutover_at: cutoverAt,
      reconciled_through: cutoverAt,
    };
    await tx`
      UPDATE public.budget_control_cutovers
      SET status = 'ready',
          reconciled_through = ${cutoverAt}::TIMESTAMPTZ,
          reconciliation_snapshot = ${tx.json(reconciliationSnapshot)}::JSONB,
          reconciliation_snapshot_hash = ${await jsonHash(tx, reconciliationSnapshot)}
      WHERE builder_id = ${builderId}::UUID
    `;

    const ruleRevisionId = crypto.randomUUID();
    const ruleSnapshot: JsonObject = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      target_customer_id: null,
      period: 'day',
      enforcement: 'hard_stop',
      limit_usd: limitUsd,
    };
    await tx`
      INSERT INTO public.budget_rule_revisions (
        builder_id, id, rule_key, revision, scope, target_customer_id,
        period, enforcement, limit_usd, config_snapshot, config_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${ruleRevisionId}::UUID, ${ruleKey}::UUID, 0,
        'pooled', NULL, 'day', 'hard_stop', ${limitUsd}::NUMERIC,
        ${tx.json(ruleSnapshot)}::JSONB, ${await jsonHash(tx, ruleSnapshot)}
      )
    `;

    const periods = await tx<{ period_end: string; period_start: string }[]>`
      WITH bounds AS (
        SELECT date_trunc('day', pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')
                 AT TIME ZONE 'UTC' AS period_start
      )
      SELECT public.pylva_budget_timestamp_text(period_start) AS period_start,
             public.pylva_budget_timestamp_text(period_start + INTERVAL '1 day') AS period_end
      FROM bounds
    `;
    const period = periods[0];
    if (!period) throw new Error('period calculation returned no row');
    const accountId = crypto.randomUUID();
    const accountSnapshot: JsonObject = {
      schema_version: '1.0',
      rule_key: ruleKey,
      scope: 'pooled',
      subject_customer_id: null,
      period: 'day',
      period_start: period.period_start,
      period_end: period.period_end,
      enforcement: 'hard_stop',
      limit_usd: limitUsd,
      opening_committed_usd: '0',
    };
    await tx`
      INSERT INTO public.budget_accounts (
        builder_id, id, rule_key, enforcement, limit_usd, scope,
        subject_customer_id, period, period_start, period_end,
        initial_rule_revision_id, initial_rule_snapshot, initial_rule_snapshot_hash,
        opening_committed_usd, committed_usd, reserved_usd, unresolved_usd
      )
      VALUES (
        ${builderId}::UUID, ${accountId}::UUID, ${ruleKey}::UUID,
        'hard_stop', ${limitUsd}::NUMERIC, 'pooled', NULL, 'day',
        ${period.period_start}::TIMESTAMPTZ, ${period.period_end}::TIMESTAMPTZ,
        ${ruleRevisionId}::UUID, ${tx.json(accountSnapshot)}::JSONB,
        ${await jsonHash(tx, accountSnapshot)}, 0, 0, 0, 0
      )
    `;

    const openingEvidence: JsonObject = {
      schema_version: '1.0',
      source: 'exact_backfill',
      builder_id: builderId,
      account_id: accountId,
      rule_key: ruleKey,
      scope: 'pooled',
      subject_customer_id: null,
      period: 'day',
      period_start: period.period_start,
      period_end: period.period_end,
      cutover_at: cutoverAt,
      measured_through: cutoverAt,
      opening_committed_usd: '0',
    };
    await tx`
      INSERT INTO public.budget_account_opening_evidence (
        builder_id, account_id, source, opening_committed_usd,
        measured_through, evidence_snapshot, evidence_snapshot_hash
      )
      VALUES (
        ${builderId}::UUID, ${accountId}::UUID, 'exact_backfill', 0,
        ${cutoverAt}::TIMESTAMPTZ, ${tx.json(openingEvidence)}::JSONB,
        ${await jsonHash(tx, openingEvidence)}
      )
    `;

    await tx`
      INSERT INTO public.cost_sources (
        builder_id, source_type, display_name, slug, metric, unit,
        price_per_unit, pricing_tiers, status, approved_at, tracking_status
      )
      VALUES (
        ${builderId}::UUID, 'non_llm_manual', 'Tavily Search',
        'tavily-search', 'credit', 'credit', ${UNIT_PRICE_USD}::NUMERIC, NULL,
        'healthy', pg_catalog.clock_timestamp(), 'tracked'
      )
    `;
  });

  return { builderId, ruleKey };
}

async function requestBody(
  input: string | URL | Request,
  initValue?: RequestInit,
): Promise<string> {
  if (input instanceof Request) return input.clone().text();
  const body = initValue?.body;
  return typeof body === 'string' ? body : '';
}

function backendHarness(builderId: string): BackendHarness {
  const reserve = createReserveBudgetUsage({
    client: db(),
    controlEnabled: () => true,
    ensureBudgetAccountsMaterialized: async () => undefined,
    maxAttempts: 1,
  });
  const lifecycle = createBudgetLifecycleService({
    transactionOptions: { client: db(), maxAttempts: 1 },
  });
  const context: BudgetControlServiceContext = {
    builderId,
    keyId: crypto.randomUUID(),
    sdkIdentity: SDK_IDENTITY,
  };
  const handler = createBudgetControlHttpHandler({
    controlEnabled: () => true,
    services: {
      reserveBudgetUsage: (_context, request) => reserve(builderId, request, SDK_IDENTITY),
      commitBudgetUsage: (_context, reservationId, request) =>
        lifecycle.commitBudgetUsage(builderId, reservationId, request, SDK_IDENTITY),
      releaseBudgetUsage: (_context, reservationId, request) =>
        lifecycle.releaseBudgetUsage(builderId, reservationId, request, SDK_IDENTITY),
      extendBudgetUsage: (_context, reservationId, request) =>
        lifecycle.extendBudgetUsage(builderId, reservationId, request, SDK_IDENTITY),
    },
  });
  const bodies: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, initValue?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const rawBody = await requestBody(input, initValue);
    if (rawBody) bodies.push(rawBody);
    let response;
    if (url.pathname === '/api/v1/budget/capabilities') {
      response = await handler.capabilities(context);
    } else if (url.pathname === '/api/v1/budget/reservations') {
      response = await handler.reserve({ context, rawBody });
    } else {
      const match = url.pathname.match(
        /^\/api\/v1\/budget\/reservations\/([^/]+)\/(commit|release|extend)$/,
      );
      if (!match) throw new Error(`unexpected SDK request path ${url.pathname}`);
      const reservationId = decodeURIComponent(match[1]!);
      const inputValue = { context, reservationId, rawBody };
      response =
        match[2] === 'commit'
          ? await handler.commit(inputValue)
          : match[2] === 'release'
            ? await handler.release(inputValue)
            : await handler.extend(inputValue);
    }
    return new Response(response.body, {
      status: response.status,
      headers: response.headers,
    });
  });
  return { bodies, fetch };
}

function configureSdk(): void {
  init({
    apiKey: SDK_KEY,
    endpoint: CONTROL_ENDPOINT,
    control: {
      mode: ControlMode.ENFORCE,
      onUnavailable: ControlUnavailablePolicy.DENY,
      timeoutMs: 5_000,
    },
  });
}

function resetSdk(): void {
  _resetControlClientForTests();
  _resetConfigForTests();
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'budget_tavily_pricing' });
  try {
    await applyMigrationsThrough(scratch, '051');
  } catch (error) {
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
});

beforeEach(resetSdk);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetSdk();
});

afterAll(async () => {
  await scratch?.drop();
  scratch = undefined;
});

describe('Tavily authoritative pricing through the SDK and real PostgreSQL services', () => {
  it.each([
    {
      credits: 1,
      actualUsd: '0.125',
      overageUsd: '0',
      exceeded: false,
      boundViolated: false,
    },
    {
      credits: 2,
      actualUsd: '0.25',
      overageUsd: '0.125',
      exceeded: true,
      boundViolated: true,
    },
  ])(
    'reserves one credit and transactionally commits exact $credits-credit evidence',
    async ({ credits, actualUsd, overageUsd, exceeded, boundViolated }) => {
      const fixture = await seedControlledBuilder(UNIT_PRICE_USD);
      const backend = backendHarness(fixture.builderId);
      vi.stubGlobal('fetch', backend.fetch);
      configureSdk();
      const privateQuery = `private query ${crypto.randomUUID()}`;
      const providerValue = { usage: { credits }, results: [{ url: 'https://private.invalid' }] };
      const client = {
        search: vi.fn(async () => providerValue),
      };

      const result = await controlledTavilySearch(client, {
        query: privateQuery,
        customerId: 'customer_acme',
      });

      expect(result.value).toBe(providerValue);
      expect(result.control).toMatchObject({
        decision: 'reserved',
        settlement: 'committed',
        maximumValue: '1',
        actualValue: String(credits),
        boundViolated,
        authoritativeOwnership: true,
        legacyTelemetryEmitted: false,
        commit: {
          reservedUsd: UNIT_PRICE_USD,
          actualUsd,
          releasedUsd: '0',
          overageUsd,
          budgetExceededAfterCommit: exceeded,
        },
      });
      expect(client.search).toHaveBeenCalledOnce();
      expect(client.search).toHaveBeenCalledWith(privateQuery, {
        searchDepth: 'basic',
        autoParameters: false,
        includeUsage: true,
      });
      expect(backend.bodies.join('\n')).not.toContain(privateQuery);

      const evidence = await withBuilder(
        fixture.builderId,
        (tx) => tx<
          {
            actual_cost_usd: string;
            actual_value: string;
            cost_source_slug: string;
            maximum_value: string;
            metric: string;
            outbox_cost_usd: string;
            outbox_count: number;
            outbox_hash_valid: boolean;
            outbox_metric_value: string;
            outbox_slug: string;
            overage_usd: string;
            pricing_metric: string;
            pricing_slug: string;
            pricing_unit_cost_usd: string;
            reserved_usd: string;
          }[]
        >`
          SELECT public.pylva_budget_decimal_text(reservation.maximum_value) AS maximum_value,
                 public.pylva_budget_decimal_text(reservation.reserved_usd) AS reserved_usd,
                 public.pylva_budget_decimal_text(reservation.overage_usd) AS overage_usd,
                 reservation.pricing_snapshot->>'cost_source_slug' AS pricing_slug,
                 reservation.pricing_snapshot->>'metric' AS pricing_metric,
                 reservation.pricing_snapshot->>'unit_cost_usd' AS pricing_unit_cost_usd,
                 usage.cost_source_slug,
                 usage.metric,
                 public.pylva_budget_decimal_text(usage.actual_value) AS actual_value,
                 public.pylva_budget_decimal_text(usage.actual_cost_usd) AS actual_cost_usd,
                 outbox.payload->>'metric_value' AS outbox_metric_value,
                 outbox.payload->>'cost_usd' AS outbox_cost_usd,
                 outbox.payload->'metadata'->>'cost_source_slug' AS outbox_slug,
                 outbox.payload_hash = public.pylva_budget_jsonb_sha256(outbox.payload)
                   AS outbox_hash_valid,
                 COUNT(*) OVER ()::INTEGER AS outbox_count
          FROM public.budget_reservations reservation
          JOIN public.budget_usage_ledger usage
            ON usage.builder_id = reservation.builder_id
           AND usage.reservation_decision_id = reservation.decision_id
          JOIN public.budget_cost_event_outbox outbox
            ON outbox.builder_id = usage.builder_id
           AND outbox.usage_ledger_id = usage.id
          WHERE reservation.builder_id = ${fixture.builderId}::UUID
        `,
      );
      expect(evidence).toEqual([
        {
          maximum_value: '1',
          reserved_usd: UNIT_PRICE_USD,
          overage_usd: overageUsd,
          pricing_slug: 'tavily-search',
          pricing_metric: 'credit',
          pricing_unit_cost_usd: UNIT_PRICE_USD,
          cost_source_slug: 'tavily-search',
          metric: 'credit',
          actual_value: String(credits),
          actual_cost_usd: actualUsd,
          outbox_metric_value: String(credits),
          outbox_cost_usd: actualUsd,
          outbox_slug: 'tavily-search',
          outbox_hash_valid: true,
          outbox_count: 1,
        },
      ]);
    },
  );

  it('refuses before Tavily dispatch when the one-credit hold exceeds the hard limit', async () => {
    const fixture = await seedControlledBuilder('0.124');
    const backend = backendHarness(fixture.builderId);
    vi.stubGlobal('fetch', backend.fetch);
    configureSdk();
    const client = {
      search: vi.fn(async () => ({ usage: { credits: 1 }, results: [] })),
    };

    const refusal = controlledTavilySearch(client, {
      query: 'must never reach Tavily',
      customerId: 'customer_refused',
    });
    await expect(refusal).rejects.toBeInstanceOf(PylvaBudgetExceeded);
    await expect(refusal).rejects.toMatchObject({
      name: 'PylvaBudgetExceeded',
      authoritativeDenial: {
        decision: 'denied',
        requestedUsd: UNIT_PRICE_USD,
        limitUsd: '0.124',
      },
    });
    expect(client.search).not.toHaveBeenCalled();

    const closure = await withBuilder(
      fixture.builderId,
      (tx) => tx<{ outbox_count: number; refused_count: number; usage_count: number }[]>`
        SELECT
          (SELECT COUNT(*)::INTEGER
           FROM public.budget_reservations
           WHERE builder_id = ${fixture.builderId}::UUID
             AND decision = 'denied' AND state = 'refused') AS refused_count,
          (SELECT COUNT(*)::INTEGER
           FROM public.budget_usage_ledger
           WHERE builder_id = ${fixture.builderId}::UUID) AS usage_count,
          (SELECT COUNT(*)::INTEGER
           FROM public.budget_cost_event_outbox
           WHERE builder_id = ${fixture.builderId}::UUID) AS outbox_count
      `,
    );
    expect(closure[0]).toEqual({ refused_count: 1, usage_count: 0, outbox_count: 0 });
  });
});
