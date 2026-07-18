// Phase 4 — THE per-customer rules matrix. One builder with hundreds of
// customers and a full rule matrix, exercised end-to-end through the REAL
// stack (PG + RLS, ClickHouse, ingest handler, rules route, TS SDK budget
// hooks, post-call evaluator, budget sync, margin evaluator). Every rule
// spec carries its own expectations; assertions iterate the specs.
//
// Spend ledger note: pooled rules aggregate across ALL of the builder's
// real traffic, so the ingest order below is deliberate — the SDK-loop
// group runs before the big per-customer batches so pooled limits cross at
// a known point. Each $1 of spend = one event of 100 in + 100 out tokens
// priced at $5000/1M both ways via a dedicated llm_pricing row.
//
// Knob: MATRIX_N (default 400 bulk-seeded; 20 more auto-register via
// ingest → 420 total). Crank locally for scale runs.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { NextRequest } from 'next/server.js';
import { RuleEnforcement, RuleStatus, RuleType, type Rule } from '@pylva/shared';
import { queryCostEvents } from '../../src/lib/clickhouse/client.js';
import { handleTelemetryIngest } from '../../src/lib/ingest/public-handler.js';
import { resetPricingCaches } from '../../src/lib/ingest/pricing-lookup.js';
import { reconcileBudgetSync } from '../../src/lib/budget/sync-handler.js';
import { listActiveRulesForCustomer, getRule } from '../../src/lib/rules/repository.js';
import { _resetPostCallEvalForTests } from '../../src/lib/rules/post-call-evaluator.js';
import { evaluateMarginRules } from '../../src/lib/rules/margin-evaluator.js';
import { loadModelTierCatalog } from '../../src/lib/anomaly/model-tier-catalog.js';
import { GET as rulesRouteGET } from '../../src/app/api/v1/rules/route.js';
import {
  cleanupMatrixBuilder,
  ingestEvents,
  insertDemoCostEvents,
  insertLegacyRule,
  seedCustomers,
  seedRuleMatrix,
  telemetryEvent,
  type RuleSpec,
} from '../helpers/rules-matrix.js';
// --- real TS SDK internals (the same call path the provider wrappers use) ---
import { init, flush, PylvaBudgetExceeded } from '../../packages/sdk-ts/src/index.js';
import { maybeEnforcePreCall } from '../../packages/sdk-ts/src/wrappers/_budget.js';
import { enqueue, _resetTelemetryForTests } from '../../packages/sdk-ts/src/core/telemetry.js';
import {
  ensureRulesCache,
  _resetRulesCacheForTests,
} from '../../packages/sdk-ts/src/core/rules_cache.js';
import {
  ensurePricingCache,
  _resetPricingCacheForTests,
} from '../../packages/sdk-ts/src/core/pricing_cache.js';
import { _resetAccumulatorForTests } from '../../packages/sdk-ts/src/core/budget_accumulator.js';
import { _resetConfigForTests } from '../../packages/sdk-ts/src/core/config.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';
const TEST_DATABASE_URL = process.env['PYLVA_TEST_DATABASE_URL'] ?? DATABASE_URL;
const MATRIX_N = Number(process.env['MATRIX_N'] ?? 400);
const AUTO_REGISTERED = 20;

const PROVIDER = 'matrixprov';
const MODEL = 'matrix-1';
const SDK_ENDPOINT = 'https://matrix.pylva.test';
const SDK_KEY = 'pv_live_ab12cd34_00000000000000000000000000000000';

let sql: ReturnType<typeof postgres>;
let builderA = '';
let builderB = '';
let customers: string[] = [];
let rulesByKey = new Map<string, Rule>();
let legacyPooledTargetedId = '';
let builderBRuleId = '';
let fetchSpy: {
  mockRestore: () => void;
  mock: { calls: Array<[unknown, ...unknown[]]> };
} | null = null;

// ---------------------------------------------------------------------------
// The matrix. `expect` blocks are the single source of truth for targeting.
// ---------------------------------------------------------------------------
const applyToAll = () => true;
const applyToOnly = (id: string) => (c: string) => c === id;

function matrixSpecs(): RuleSpec[] {
  return [
    // Created FIRST so the newer global rule sits ahead of it in the
    // newest-first rules cache — the B1 regression arrangement where the
    // old first-match SDK silently ignored a customer's own cap.
    {
      key: 'targeted_override_50',
      type: RuleType.BUDGET_LIMIT,
      customer_id: 'cust_0100',
      config: { limit_usd: 50, period: 'day', hard_stop: true, scope: 'per_customer' },
      expect: { appliesTo: applyToOnly('cust_0100'), visibleToSdk: true, firesAlert: true },
    },
    {
      key: 'targeted_strict_2',
      type: RuleType.BUDGET_LIMIT,
      customer_id: 'cust_0102',
      config: { limit_usd: 2, period: 'day', hard_stop: true, scope: 'per_customer' },
      expect: { appliesTo: applyToOnly('cust_0102'), visibleToSdk: true, firesAlert: true },
    },
    {
      key: 'targeted_soft_1',
      type: RuleType.BUDGET_LIMIT,
      customer_id: 'cust_0101',
      config: { limit_usd: 1, period: 'day', hard_stop: false, scope: 'per_customer' },
      expect: { appliesTo: applyToOnly('cust_0101'), visibleToSdk: true, firesAlert: true },
    },
    {
      key: 'global_hard_5',
      type: RuleType.BUDGET_LIMIT,
      config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' },
      expect: { appliesTo: applyToAll, visibleToSdk: true, firesAlert: true },
    },
    {
      key: 'global_pooled_20',
      type: RuleType.BUDGET_LIMIT,
      config: { limit_usd: 20, period: 'day', hard_stop: true, scope: 'pooled' },
      expect: { appliesTo: applyToAll, visibleToSdk: true, firesAlert: true },
    },
    {
      key: 'targeted_threshold_3',
      type: RuleType.COST_THRESHOLD,
      customer_id: 'cust_0103',
      config: { threshold_usd: 3, period: 'day', scope: 'per_customer' },
      expect: { appliesTo: applyToOnly('cust_0103'), visibleToSdk: false, firesAlert: true },
    },
    {
      key: 'global_draft',
      type: RuleType.BUDGET_LIMIT,
      status: RuleStatus.DRAFT,
      config: { limit_usd: 1, period: 'day', hard_stop: true, scope: 'per_customer' },
      expect: { appliesTo: () => false, visibleToSdk: false, firesAlert: false },
    },
    {
      key: 'targeted_disabled',
      type: RuleType.BUDGET_LIMIT,
      customer_id: 'cust_0104',
      enabled: false,
      config: { limit_usd: 1, period: 'day', hard_stop: true, scope: 'per_customer' },
      expect: { appliesTo: () => false, visibleToSdk: false, firesAlert: false },
    },
    {
      key: 'postcall_budget_4',
      type: RuleType.BUDGET_LIMIT,
      customer_id: 'cust_0105',
      enforcement: RuleEnforcement.POST_CALL,
      config: { limit_usd: 4, period: 'day', hard_stop: false, scope: 'per_customer' },
      expect: { appliesTo: applyToOnly('cust_0105'), visibleToSdk: false, firesAlert: true },
    },
    {
      key: 'routing_broad',
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'pooled',
        match: { provider: PROVIDER, model: MODEL },
        route_to: { provider: PROVIDER, model: 'matrix-2' },
        fallback: {
          on_cross_provider_auth_error: true,
          on_access_denied: true,
          on_model_not_found: true,
          use_original_model: true,
          skip_same_provider_401: true,
        },
      },
      expect: { appliesTo: applyToAll, visibleToSdk: true },
    },
    {
      key: 'routing_specific',
      type: RuleType.MODEL_ROUTING,
      config: {
        scope: 'pooled',
        match: { provider: PROVIDER, model: MODEL, step_name: 'stepA' },
        route_to: { provider: PROVIDER, model: 'matrix-3' },
        fallback: {
          on_cross_provider_auth_error: true,
          on_access_denied: true,
          on_model_not_found: true,
          use_original_model: true,
          skip_same_provider_401: true,
        },
      },
      expect: { appliesTo: applyToAll, visibleToSdk: true },
    },
    {
      key: 'margin_global_20',
      type: RuleType.MARGIN_PROTECTION,
      status: RuleStatus.ACTIVE,
      config: { margin_threshold_pct: 20, period: 'day', scope: 'per_customer' },
      expect: { appliesTo: applyToAll, visibleToSdk: false, firesAlert: true },
    },
  ];
}

const SPECS = matrixSpecs();

function specRule(key: string): Rule {
  const rule = rulesByKey.get(key);
  if (!rule) throw new Error(`matrix spec ${key} not seeded`);
  return rule;
}

/** Rule ids expected from listActiveRulesForCustomer for an external id. */
function expectedActiveRuleIds(externalId: string): string[] {
  const fromSpecs = SPECS.filter(
    (s) => (s.enabled ?? true) && (s.status ?? RuleStatus.ACTIVE) === RuleStatus.ACTIVE,
  )
    .filter((s) => s.expect.appliesTo(externalId))
    .map((s) => specRule(s.key).id);
  // The legacy pooled+targeted row targets cust_0106 only.
  if (externalId === 'cust_0106') fromSpecs.push(legacyPooledTargetedId);
  return fromSpecs.sort();
}

async function ingestSpend(
  builderId: string,
  customerId: string,
  usd: number,
  overrides: Record<string, unknown> = {},
) {
  const events = Array.from({ length: usd }, () =>
    telemetryEvent(customerId, { provider: PROVIDER, model: MODEL, ...overrides }),
  );
  const results = await ingestEvents(builderId, events);
  return results[results.length - 1]!;
}

function flagsOf(result: { body: { budget_exceeded?: Array<Record<string, unknown>> } }) {
  return result.body.budget_exceeded ?? [];
}

async function waitForAlertRows(
  builderId: string,
  ruleId: string,
  timeoutMs = 10_000,
): Promise<Array<{ id: string; payload: Record<string, unknown> }>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await sql<Array<{ id: string; payload: Record<string, unknown> }>>`
      SELECT id, payload FROM alert_history
      WHERE builder_id = ${builderId} AND rule_id = ${ruleId}
    `;
    if (rows.length > 0 || Date.now() > deadline) return rows;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function sdkHeaders(builderId: string): Record<string, string> {
  return { 'x-builder-id': builderId, 'x-key-id': 'matrix-key' };
}

function dashboardHeaders(builderId: string): Record<string, string> {
  return { 'x-builder-id': builderId, 'x-user-id': 'user-1', 'x-user-role': 'owner' };
}

async function fetchRulesRoute(headers: Record<string, string>): Promise<{
  rules: Rule[];
  ttl_seconds: number;
}> {
  const response = await rulesRouteGET(
    new NextRequest('http://localhost/api/v1/rules', { method: 'GET', headers }),
  );
  return (await response.json()) as { rules: Rule[]; ttl_seconds: number };
}

function installSdkFetchMock(): void {
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init2) => {
    const href = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    if (href === `${SDK_ENDPOINT}/api/v1/rules`) {
      const body = await fetchRulesRoute(sdkHeaders(builderA));
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (href === `${SDK_ENDPOINT}/api/v1/pricing`) {
      return new Response(
        JSON.stringify({
          models: [{ provider: PROVIDER, model: MODEL, input_per_1m: 5000, output_per_1m: 5000 }],
        }),
        { status: 200 },
      );
    }
    if (href === `${SDK_ENDPOINT}/api/v1/events`) {
      const response = await handleTelemetryIngest({
        builderId: builderA,
        keyId: 'matrix-key',
        rawBody: String(init2?.body ?? ''),
      });
      return new Response(response.body, { status: response.status });
    }
    if (href === `${SDK_ENDPOINT}/api/v1/budget/sync`) {
      const parsed = JSON.parse(String(init2?.body ?? '{}')) as { entries?: unknown[] };
      const entries = await reconcileBudgetSync(
        builderA,
        (parsed.entries ?? []) as Parameters<typeof reconcileBudgetSync>[1],
      );
      return new Response(JSON.stringify({ entries }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

beforeAll(async () => {
  sql = postgres(TEST_DATABASE_URL);

  const suffix = crypto.randomBytes(5).toString('hex');
  const [rowA] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`matrix-a-${suffix}@example.com`}, 'Matrix A', 'scale', ${`matrix-a-${suffix}`})
    RETURNING id
  `;
  builderA = rowA!.id;
  const [rowB] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`matrix-b-${suffix}@example.com`}, 'Matrix B', 'scale', ${`matrix-b-${suffix}`})
    RETURNING id
  `;
  builderB = rowB!.id;

  // Dedicated pricing row: 100 in + 100 out tokens = exactly $1.
  await sql`
    INSERT INTO llm_pricing (provider, model, input_per_1m, output_per_1m, effective_from, source)
    VALUES (${PROVIDER}, ${MODEL}, 5000, 5000, now() - interval '1 day', 'admin')
  `;
  resetPricingCaches();

  customers = await seedCustomers(sql, builderA, MATRIX_N, 'cust');
  // Builder B holds the SAME external ids (isolation control).
  await seedCustomers(sql, builderB, 5, 'cust');

  rulesByKey = await seedRuleMatrix(builderA, SPECS);
  // Legacy pooled+targeted row — bypasses F3 validation on purpose.
  legacyPooledTargetedId = await insertLegacyRule(sql, {
    builderId: builderA,
    type: RuleType.BUDGET_LIMIT,
    name: 'legacy pooled targeted',
    customer_id: 'cust_0106',
    config: { limit_usd: 9, period: 'day', hard_stop: true, scope: 'pooled' },
  });
  const [bRule] = await seedRuleMatrix(builderB, [
    {
      key: 'b_global_hard_5',
      type: RuleType.BUDGET_LIMIT,
      config: { limit_usd: 5, period: 'day', hard_stop: true, scope: 'per_customer' },
      expect: { appliesTo: applyToAll, visibleToSdk: true, firesAlert: true },
    },
  ]).then((m) => [...m.values()]);
  builderBRuleId = bRule!.id;

  _resetPostCallEvalForTests();
}, 120_000);

afterAll(async () => {
  fetchSpy?.mockRestore();
  _resetTelemetryForTests();
  _resetRulesCacheForTests();
  _resetPricingCacheForTests();
  _resetAccumulatorForTests();
  _resetConfigForTests();
  if (builderA) await cleanupMatrixBuilder(sql, builderA);
  if (builderB) await cleanupMatrixBuilder(sql, builderB);
  await sql`DELETE FROM llm_pricing WHERE provider = ${PROVIDER}`;
  await sql.end();
}, 120_000);

describe('per-customer rules matrix (420 customers)', () => {
  // ------------------------------------------------------------------ G1
  it('targeting sweep: exact rule sets per customer', async () => {
    for (const externalId of [
      'cust_0100',
      'cust_0101',
      'cust_0102',
      'cust_0103',
      'cust_0104',
      'cust_0105',
      'cust_0106',
      'cust_0000',
    ]) {
      const rules = await listActiveRulesForCustomer(builderA, externalId);
      expect(rules.map((r) => r.id).sort(), `rule set for ${externalId}`).toEqual(
        expectedActiveRuleIds(externalId),
      );
    }

    // Unknown customer → only untargeted actives.
    const unknown = await listActiveRulesForCustomer(builderA, 'cust_never_ingested');
    expect(unknown.map((r) => r.id).sort()).toEqual(expectedActiveRuleIds('cust_never_ingested'));

    // 50-customer sample, spec-driven.
    const sample = customers.filter((_, i) => i % Math.ceil(MATRIX_N / 50) === 0).slice(0, 50);
    for (const externalId of sample) {
      const rules = await listActiveRulesForCustomer(builderA, externalId);
      expect(rules.map((r) => r.id).sort(), `sampled ${externalId}`).toEqual(
        expectedActiveRuleIds(externalId),
      );
    }
  });

  it('targeting sweep: one-SQL cross-check over the full audience', async () => {
    const rows = await sql<Array<{ external_id: string; rule_count: string }>>`
      SELECT c.external_id, count(r.id) AS rule_count
      FROM customers c
      JOIN rules r
        ON r.builder_id = c.builder_id
       AND r.enabled = true
       AND r.status = 'active'
       AND (r.customer_id IS NULL OR r.customer_id = c.external_id)
      WHERE c.builder_id = ${builderA}
      GROUP BY c.external_id
    `;
    expect(rows.length).toBe(MATRIX_N);
    for (const row of rows) {
      expect(Number(row.rule_count), `rule count for ${row.external_id}`).toBe(
        expectedActiveRuleIds(row.external_id).length,
      );
    }
  });

  // ------------------------------------------------------------------ G2
  it('SDK rules payload: exactly active + enabled + pre_call', async () => {
    const { rules, ttl_seconds } = await fetchRulesRoute(sdkHeaders(builderA));
    expect(ttl_seconds).toBe(60);

    const expected = SPECS.filter((s) => s.expect.visibleToSdk)
      .map((s) => specRule(s.key).id)
      .concat(legacyPooledTargetedId) // legacy row is active+enabled+pre_call
      .sort();
    expect(rules.map((r) => r.id).sort()).toEqual(expected);
  });

  it('dashboard rules payload: everything, drafts and disabled included', async () => {
    const { rules } = await fetchRulesRoute(dashboardHeaders(builderA));
    const expected = SPECS.map((s) => specRule(s.key).id)
      .concat(legacyPooledTargetedId)
      .sort();
    expect(rules.map((r) => r.id).sort()).toEqual(expected);
  });

  it('builder B sees only its own rules', async () => {
    const { rules } = await fetchRulesRoute(sdkHeaders(builderB));
    expect(rules.map((r) => r.id)).toEqual([builderBRuleId]);
  });

  // ------------------------------------------------------------------ G3
  it('live SDK loop: local spend accounting blocks without any backend round-trip', async () => {
    installSdkFetchMock();
    init({ apiKey: SDK_KEY, endpoint: SDK_ENDPOINT, batchSize: 1000, flushInterval: 600_000 });
    await ensureRulesCache();
    await ensurePricingCache();

    // cust_0200: only the global $5 hard cap applies. Enqueue $5 of spend —
    // recordLlmSpend prices it locally at enqueue time; nothing flushed yet.
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_0200', estimated_usd: 0 })).not.toThrow();
    for (let i = 0; i < 5; i++) {
      enqueue({
        run_id: crypto.randomUUID(),
        parent_run_id: null,
        trace_id: crypto.randomUUID(),
        span_id: crypto.randomUUID(),
        parent_span_id: null,
        customer_id: 'cust_0200',
        step_name: null,
        model: MODEL,
        provider: PROVIDER,
        tokens_in: 100,
        tokens_out: 100,
        latency_ms: 10,
        tool_name: null,
        status: 'success',
        framework: 'none',
        instrumentation_tier: 'sdk_wrapper',
        cost_source: 'configured',
        metric: null,
        metric_value: null,
        stream_aborted: false,
        abort_savings_usd: 0,
        timestamp: new Date().toISOString(),
      });
    }
    // No /events call has happened — the block is purely local accounting.
    const eventCalls = fetchSpy!.mock.calls.filter(([u]) => String(u).includes('/api/v1/events'));
    expect(eventCalls).toHaveLength(0);
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_0200', estimated_usd: 0 })).toThrow(
      PylvaBudgetExceeded,
    );
    // Other customers stay unaffected (per-customer scope).
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_0201', estimated_usd: 0 })).not.toThrow();

    // Land the spend server-side for the later aggregate groups.
    await flush();
  });

  it('live SDK loop: backend budget_exceeded flags block beyond local knowledge (strict targeted cap)', async () => {
    // Server already holds $2 for cust_0102 (its strict cap) via raw ingest…
    const raw = await ingestSpend(builderA, 'cust_0102', 2);
    expect(flagsOf(raw).map((f) => f.rule_id)).toContain(specRule('targeted_strict_2').id);

    // …while the SDK's local view is wiped (fresh process, restart, etc.).
    _resetAccumulatorForTests();
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_0102', estimated_usd: 0 })).not.toThrow();

    // One more $1 call: locally under the $2 cap, but the ingest response
    // flags the crossing (server truth $3 ≥ $2) and the SDK must block the
    // NEXT call. This is the B1 arrangement — the newer global $5 rule sits
    // first in the cache; the old first-match SDK never looked at the
    // customer's own stricter cap.
    enqueue({
      run_id: crypto.randomUUID(),
      parent_run_id: null,
      trace_id: crypto.randomUUID(),
      span_id: crypto.randomUUID(),
      parent_span_id: null,
      customer_id: 'cust_0102',
      step_name: null,
      model: MODEL,
      provider: PROVIDER,
      tokens_in: 100,
      tokens_out: 100,
      latency_ms: 10,
      tool_name: null,
      status: 'success',
      framework: 'none',
      instrumentation_tier: 'sdk_wrapper',
      cost_source: 'configured',
      metric: null,
      metric_value: null,
      stream_aborted: false,
      abort_savings_usd: 0,
      timestamp: new Date().toISOString(),
    });
    await flush();

    let thrown: unknown = null;
    try {
      maybeEnforcePreCall({ customer_id: 'cust_0102', estimated_usd: 0 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PylvaBudgetExceeded);
    expect((thrown as PylvaBudgetExceeded).rule_id).toBe(specRule('targeted_strict_2').id);
  });

  it('live SDK loop: soft rules warn but never block', async () => {
    // cust_0101 carries a $1 SOFT cap; $3 of local spend must not throw.
    for (let i = 0; i < 3; i++) {
      enqueue({
        run_id: crypto.randomUUID(),
        parent_run_id: null,
        trace_id: crypto.randomUUID(),
        span_id: crypto.randomUUID(),
        parent_span_id: null,
        customer_id: 'cust_0101',
        step_name: null,
        model: MODEL,
        provider: PROVIDER,
        tokens_in: 100,
        tokens_out: 100,
        latency_ms: 10,
        tool_name: null,
        status: 'success',
        framework: 'none',
        instrumentation_tier: 'sdk_wrapper',
        cost_source: 'configured',
        metric: null,
        metric_value: null,
        stream_aborted: false,
        abort_savings_usd: 0,
        timestamp: new Date().toISOString(),
      });
    }
    expect(() => maybeEnforcePreCall({ customer_id: 'cust_0101', estimated_usd: 0 })).not.toThrow();
    await flush();
  });

  // ------------------------------------------------------------------ G4
  it('budget_exceeded flags: per-customer isolation and both overlapping rules flagged', async () => {
    // cust_0103: $3 (threshold rule is cost_threshold — no budget flags).
    const r0103 = await ingestSpend(builderA, 'cust_0103', 3);
    expect(flagsOf(r0103).filter((f) => f.customer_id === 'cust_0103')).toEqual([]);

    // cust_0105: $4 crosses its post_call budget rule — still flagged.
    const r0105 = await ingestSpend(builderA, 'cust_0105', 4);
    const f0105 = flagsOf(r0105).filter((f) => f.customer_id === 'cust_0105');
    expect(f0105.map((f) => f.rule_id)).toContain(specRule('postcall_budget_4').id);

    // cust_0100: $50 crosses BOTH its own $50 override and the global $5 —
    // enforce-all semantics mean both flags fire for this customer.
    const r0100 = await ingestSpend(builderA, 'cust_0100', 50);
    const f0100 = flagsOf(r0100).filter((f) => f.customer_id === 'cust_0100');
    expect(f0100.map((f) => f.rule_id).sort()).toEqual(
      [specRule('global_hard_5').id, specRule('targeted_override_50').id].sort(),
    );

    // …and none of that spend flags a different customer.
    const strayFlags = flagsOf(r0100).filter(
      (f) => f.customer_id !== 'cust_0100' && f.customer_id !== null,
    );
    expect(strayFlags).toEqual([]);

    // Pooled rules crossed during the cumulative build-up: flags carry
    // customer_id null (shared pot, not attributable to one customer).
    const pooled = flagsOf(r0100).filter((f) => f.customer_id === null);
    expect(pooled.map((f) => f.rule_id)).toContain(specRule('global_pooled_20').id);
    // The legacy pooled+targeted row does NOT flag on other customers'
    // traffic — targeting narrows its rules-listing entry to cust_0106
    // even though its pot is everyone's spend. This is exactly the
    // incoherence F3 now rejects at create/update. It fires the moment
    // ITS customer sends anything, because the shared pot is already over:
    expect(pooled.map((f) => f.rule_id)).not.toContain(legacyPooledTargetedId);
    const r0106 = await ingestSpend(builderA, 'cust_0106', 1);
    const pooled0106 = flagsOf(r0106).filter((f) => f.customer_id === null);
    expect(pooled0106.map((f) => f.rule_id)).toContain(legacyPooledTargetedId);
  });

  it('budget_exceeded flags: demo traffic never counts', async () => {
    await insertDemoCostEvents(builderA, [
      { customerId: 'cust_0107', costUsd: 100 },
      { customerId: 'cust_0107', costUsd: 100 },
    ]);
    const result = await ingestSpend(builderA, 'cust_0107', 1);
    const flags = flagsOf(result).filter((f) => f.customer_id === 'cust_0107');
    expect(flags).toEqual([]); // $1 real spend < $5 global; $200 demo ignored
  });

  it('auto-registers unseen customers on ingest (the +20)', async () => {
    const autoIds = Array.from(
      { length: AUTO_REGISTERED },
      (_, i) => `cust_${String(MATRIX_N + i).padStart(4, '0')}`,
    );
    for (const externalId of autoIds) {
      await ingestSpend(builderA, externalId, 1);
    }
    const [row] = await sql<{ count: string }[]>`
      SELECT count(*) AS count FROM customers WHERE builder_id = ${builderA}
    `;
    expect(Number(row!.count)).toBeGreaterThanOrEqual(MATRIX_N + AUTO_REGISTERED);

    // Rules apply to auto-registered customers exactly like seeded ones.
    const rules = await listActiveRulesForCustomer(builderA, autoIds[0]!);
    expect(rules.map((r) => r.id).sort()).toEqual(expectedActiveRuleIds(autoIds[0]!));
  });

  // ------------------------------------------------------------------ G5
  it('post-call alerts: exactly the intended rules fire', async () => {
    // cost_threshold for cust_0103 crossed at $3 (ingested above).
    const thresholdRows = await waitForAlertRows(builderA, specRule('targeted_threshold_3').id);
    expect(thresholdRows.length).toBe(1);

    // post_call budget rule fired as a WARNED alert (soft, post-call).
    const postcallRows = await waitForAlertRows(builderA, specRule('postcall_budget_4').id);
    expect(postcallRows.length).toBe(1);
    const postcallPayload = postcallRows[0]!.payload as {
      payload: { data: { action_taken: string } };
    };
    expect(postcallPayload.payload.data.action_taken).toBe('warned');

    // Pre-call hard stop reports blocked.
    const hardRows = await waitForAlertRows(builderA, specRule('global_hard_5').id);
    expect(hardRows.length).toBeGreaterThanOrEqual(1);
    const hardPayload = hardRows[0]!.payload as {
      payload: { data: { action_taken: string } };
    };
    expect(hardPayload.payload.data.action_taken).toBe('blocked');

    // Pooled rule: exactly one row per period, customer_id null.
    const pooledRows = await waitForAlertRows(builderA, specRule('global_pooled_20').id);
    expect(pooledRows.length).toBe(1);
    const pooledPayload = pooledRows[0]!.payload as {
      payload: { data: { customer_id: string | null } };
    };
    expect(pooledPayload.payload.data.customer_id).toBeNull();

    // Draft + disabled rules never fire.
    expect(await waitForAlertRows(builderA, specRule('global_draft').id, 1_000)).toEqual([]);
    expect(await waitForAlertRows(builderA, specRule('targeted_disabled').id, 1_000)).toEqual([]);
  });

  // ------------------------------------------------------------------ G6
  it('budget sync: server totals equal ClickHouse truth', async () => {
    const periodStart = new Date();
    periodStart.setUTCHours(0, 0, 0, 0);

    const [entry] = await reconcileBudgetSync(builderA, [
      {
        rule_id: specRule('global_hard_5').id,
        scope: 'per_customer',
        customer_id: 'cust_0100',
        accumulated_cost_usd: 1,
        period_start: periodStart.toISOString(),
        event_count: 1,
      },
    ]);

    const rows = await queryCostEvents(
      builderA,
      `SELECT sum(cost_usd) AS s FROM cost_events
       WHERE builder_id = {builder_id:String}
         AND customer_id = {customer_id:String}
         AND is_demo = 0
         AND timestamp >= {from:DateTime}`,
      {
        customer_id: `${builderA}:cust_0100`,
        from: periodStart.toISOString().replace('T', ' ').slice(0, 19),
      },
    );
    const chTruth = Number((rows[0] as { s: string | null }).s ?? 0);
    expect(chTruth).toBeGreaterThanOrEqual(50);
    expect(entry!.server_total_usd).toBeCloseTo(chTruth, 4);
    expect(entry!.budget_exceeded).toBe(true);
  });

  it('budget sync: disabled rules and cross-tenant rule ids trim to zero', async () => {
    const periodStart = new Date();
    periodStart.setUTCHours(0, 0, 0, 0);
    const entries = await reconcileBudgetSync(builderA, [
      {
        rule_id: specRule('targeted_disabled').id,
        scope: 'per_customer',
        customer_id: 'cust_0104',
        accumulated_cost_usd: 3,
        period_start: periodStart.toISOString(),
        event_count: 1,
      },
      {
        rule_id: builderBRuleId, // belongs to builder B
        scope: 'per_customer',
        customer_id: 'cust_0100',
        accumulated_cost_usd: 3,
        period_start: periodStart.toISOString(),
        event_count: 1,
      },
    ]);
    for (const entry of entries) {
      expect(entry.server_total_usd).toBe(0);
      expect(entry.budget_exceeded).toBe(false);
    }
  });

  it('budget sync: legacy pooled+targeted rule reconciles instead of wiping (B4)', async () => {
    const periodStart = new Date();
    periodStart.setUTCHours(0, 0, 0, 0);
    const [entry] = await reconcileBudgetSync(builderA, [
      {
        rule_id: legacyPooledTargetedId,
        scope: 'pooled',
        customer_id: null,
        accumulated_cost_usd: 3,
        period_start: periodStart.toISOString(),
        event_count: 1,
      },
    ]);
    // Pre-fix this returned the deleted-rule zero and the SDK wiped its
    // blocked state every 5 minutes. Now: real pooled total, exceeded.
    expect(entry!.server_total_usd).toBeGreaterThan(20);
    expect(entry!.budget_exceeded).toBe(true);
  });

  // ------------------------------------------------------------------ G7
  it('cross-tenant isolation: builder B traffic with the SAME external ids changes nothing for A', async () => {
    const before = await queryCostEvents(
      builderA,
      `SELECT count() AS c FROM cost_events WHERE builder_id = {builder_id:String}`,
      {},
    );

    const result = await ingestSpend(builderB, 'cust_0100', 6);
    const bFlags = flagsOf(result);
    // B's spend crosses B's own $5 rule — and ONLY B's rule ids appear.
    expect(bFlags.map((f) => f.rule_id)).toContain(builderBRuleId);
    const aRuleIds = new Set(
      [...rulesByKey.values()].map((r) => r.id).concat(legacyPooledTargetedId),
    );
    for (const flag of bFlags) {
      expect(aRuleIds.has(String(flag.rule_id))).toBe(false);
    }

    const after = await queryCostEvents(
      builderA,
      `SELECT count() AS c FROM cost_events WHERE builder_id = {builder_id:String}`,
      {},
    );
    expect((after[0] as { c: string }).c).toBe((before[0] as { c: string }).c);

    // B's alert history references only B's rules.
    const bAlerts = await waitForAlertRows(builderB, builderBRuleId);
    expect(bAlerts.length).toBe(1);
    const aAlertRows = await sql<Array<{ rule_id: string }>>`
      SELECT rule_id FROM alert_history WHERE builder_id = ${builderA}
    `;
    for (const row of aAlertRows) {
      expect(aRuleIds.has(row.rule_id)).toBe(true);
    }
  });

  // ------------------------------------------------------------------ G8
  it('margin end-to-end: fires for exactly the low-margin priced customer', async () => {
    // Pricing: cust_0300 pays $10 flat (spend $9 → 10% margin < 20% → fire);
    // cust_0301 pays $100 flat (spend $1 → 99% margin → healthy).
    const priced = await sql<Array<{ id: string; external_id: string }>>`
      SELECT id, external_id FROM customers
      WHERE builder_id = ${builderA} AND external_id IN ('cust_0300', 'cust_0301')
    `;
    const byExternal = new Map(priced.map((r) => [r.external_id, r.id]));
    await sql`
      INSERT INTO customer_pricing (builder_id, customer_id, pricing_model, flat_rate_usd, billing_period, effective_from)
      VALUES
        (${builderA}, ${byExternal.get('cust_0300')!}, 'flat', 10, 'monthly', now() - interval '1 hour'),
        (${builderA}, ${byExternal.get('cust_0301')!}, 'flat', 100, 'monthly', now() - interval '1 hour')
    `;
    await ingestSpend(builderA, 'cust_0300', 9);
    await ingestSpend(builderA, 'cust_0301', 1);

    const catalog = await loadModelTierCatalog(new Date());
    const summary = await evaluateMarginRules({ builderId: builderA, catalog });

    expect(summary.rules_evaluated).toBe(1);
    expect(summary.alerts_fired).toBe(1);
    expect(summary.anomalies_inserted).toBe(1);

    const anomalies = await sql<Array<{ customer_id: string | null; severity: string }>>`
      SELECT customer_id, severity FROM anomaly_events
      WHERE builder_id = ${builderA} AND source_type = 'margin_risk'
    `;
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.customer_id).toBe('cust_0300');

    const marginAlerts = await waitForAlertRows(builderA, specRule('margin_global_20').id);
    expect(marginAlerts.length).toBe(1);
    const payload = marginAlerts[0]!.payload as {
      payload: { type: string; data: { customer_id: string; margin_percent: number } };
    };
    expect(payload.payload.type).toBe('margin.alert');
    expect(payload.payload.data.customer_id).toBe('cust_0300');
    expect(payload.payload.data.margin_percent).toBeCloseTo(10, 1);

    const marginRule = await getRule(builderA, specRule('margin_global_20').id);
    expect(marginRule?.last_triggered_at).toBeInstanceOf(Date);

    // Second run within the same period: idempotent, no duplicate page.
    const rerun = await evaluateMarginRules({ builderId: builderA, catalog });
    expect(rerun.alerts_fired).toBe(0);
    expect(rerun.anomalies_inserted).toBe(0);
    expect(rerun.anomalies_skipped_idempotent).toBe(1);
    expect((await waitForAlertRows(builderA, specRule('margin_global_20').id)).length).toBe(1);
  });
});
