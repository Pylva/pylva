// Phase 4 — rules repository against the REAL database. Everything the
// unit suites mock away is exercised live here: RLS scoping, targeting
// filters, enforcement defaults, status promotion stamps, and the
// dangling-external-id semantics rules rely on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import postgres from 'postgres';
import { RuleEnforcement, RuleStatus, RuleType, type Rule } from '@pylva/shared';
import {
  createRule,
  deleteRule,
  getRule,
  listActiveRulesForCustomer,
  listRules,
  markRuleTriggered,
  promoteRuleStatus,
  toggleRule,
  updateRule,
} from '../../src/lib/rules/repository.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

let sql: ReturnType<typeof postgres>;
let builderA = '';
let builderB = '';

async function createBuilder(label: string): Promise<string> {
  const suffix = crypto.randomBytes(6).toString('hex');
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO builders (email, name, tier, slug)
    VALUES (${`${label}-${suffix}@example.com`}, ${label}, 'pro', ${`${label}-${suffix}`})
    RETURNING id
  `;
  return row!.id;
}

async function seedCustomer(builderId: string, externalId: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    INSERT INTO customers (builder_id, external_id)
    VALUES (${builderId}, ${externalId})
    ON CONFLICT (builder_id, external_id) DO UPDATE SET updated_at = now()
    RETURNING id
  `;
  return row!.id;
}

function budgetConfig(limit = 5): Record<string, unknown> {
  return { limit_usd: limit, period: 'day', hard_stop: true, scope: 'per_customer' };
}

beforeAll(async () => {
  sql = postgres(DATABASE_URL);
  builderA = await createBuilder('rules-repo-a');
  builderB = await createBuilder('rules-repo-b');
  await seedCustomer(builderA, 'cust_x');
  await seedCustomer(builderA, 'Cust_X'); // case-sensitivity control
  await seedCustomer(builderA, 'cust_y');
});

afterAll(async () => {
  await sql`DELETE FROM builders WHERE id IN (${builderA}, ${builderB})`;
  await sql.end();
});

describe('createRule enforcement defaults', () => {
  it.each([
    [RuleType.BUDGET_LIMIT, budgetConfig(), RuleEnforcement.PRE_CALL],
    [
      RuleType.COST_THRESHOLD,
      { threshold_usd: 5, period: 'day', scope: 'per_customer' },
      RuleEnforcement.POST_CALL,
    ],
    [
      RuleType.MARGIN_PROTECTION,
      { margin_threshold_pct: 20, period: 'day', scope: 'per_customer' },
      RuleEnforcement.POST_CALL,
    ],
    [
      RuleType.MODEL_ROUTING,
      { scope: 'pooled', match: { model: 'gpt-4o' } },
      RuleEnforcement.PRE_CALL,
    ],
    [
      RuleType.RELIABILITY_FAILOVER,
      { primary_provider: 'openai', backup_provider: 'anthropic' },
      RuleEnforcement.PRE_CALL,
    ],
  ])('defaults %s to the correct enforcement', async (type, config, expected) => {
    const rule = await createRule({
      builder_id: builderA,
      type,
      name: `default-${type}`,
      config,
      status: RuleStatus.DRAFT,
    });
    expect(rule.enforcement).toBe(expected);
    await deleteRule(builderA, rule.id);
  });

  it('honors an explicit enforcement over the default', async () => {
    const rule = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'explicit post_call budget',
      enforcement: RuleEnforcement.POST_CALL,
      config: budgetConfig(),
      status: RuleStatus.DRAFT,
    });
    expect(rule.enforcement).toBe(RuleEnforcement.POST_CALL);
    await deleteRule(builderA, rule.id);
  });
});

describe('listActiveRulesForCustomer targeting', () => {
  const created: Rule[] = [];
  let globalRule: Rule;
  let targetedX: Rule;
  let targetedCaseX: Rule;
  let targetedY: Rule;
  let draftGlobal: Rule;
  let disabledX: Rule;

  beforeAll(async () => {
    globalRule = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'global cap',
      config: budgetConfig(5),
    });
    targetedX = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'cust_x cap',
      customer_id: 'cust_x',
      config: budgetConfig(50),
    });
    targetedCaseX = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'Cust_X cap (distinct case)',
      customer_id: 'Cust_X',
      config: budgetConfig(60),
    });
    targetedY = await createRule({
      builder_id: builderA,
      type: RuleType.COST_THRESHOLD,
      name: 'cust_y threshold',
      customer_id: 'cust_y',
      config: { threshold_usd: 10, period: 'day', scope: 'per_customer' },
    });
    draftGlobal = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'draft global',
      config: budgetConfig(1),
      status: RuleStatus.DRAFT,
    });
    disabledX = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'disabled cust_x',
      customer_id: 'cust_x',
      enabled: false,
      config: budgetConfig(2),
    });
    created.push(globalRule, targetedX, targetedCaseX, targetedY, draftGlobal, disabledX);
  });

  afterAll(async () => {
    for (const rule of created) await deleteRule(builderA, rule.id);
  });

  function ids(rules: Rule[]): string[] {
    return rules.map((r) => r.id).sort();
  }

  it('returns exactly the global + cust_x rules for cust_x (no draft, no disabled)', async () => {
    const rules = await listActiveRulesForCustomer(builderA, 'cust_x');
    expect(ids(rules)).toEqual(ids([globalRule, targetedX]));
  });

  it('treats external ids as case-sensitive', async () => {
    const rules = await listActiveRulesForCustomer(builderA, 'Cust_X');
    expect(ids(rules)).toEqual(ids([globalRule, targetedCaseX]));
  });

  it('returns global + cust_y rules for cust_y', async () => {
    const rules = await listActiveRulesForCustomer(builderA, 'cust_y');
    expect(ids(rules)).toEqual(ids([globalRule, targetedY]));
  });

  it('returns only globals for an unknown customer id', async () => {
    const rules = await listActiveRulesForCustomer(builderA, 'cust_never_seen');
    expect(ids(rules)).toEqual(ids([globalRule]));
  });

  it('RLS: builder B sees none of builder A rules', async () => {
    expect(await listActiveRulesForCustomer(builderB, 'cust_x')).toEqual([]);
    expect(await listRules(builderB)).toEqual([]);
    expect(await getRule(builderB, globalRule.id)).toBeNull();
  });

  it('still matches by external id after the customer row is deleted (dangling ref)', async () => {
    // rules.customer_id stores the external STRING, not an FK — deleting
    // the customer row leaves the rule matching that id. Re-ingest
    // auto-registers the customer again and the rule applies seamlessly.
    await sql`DELETE FROM customers WHERE builder_id = ${builderA} AND external_id = 'cust_y'`;
    const rules = await listActiveRulesForCustomer(builderA, 'cust_y');
    expect(ids(rules)).toEqual(ids([globalRule, targetedY]));
    await seedCustomer(builderA, 'cust_y');
  });
});

describe('rule lifecycle mutations', () => {
  it('promoteRuleStatus stamps activated_at and clears last_error on activation', async () => {
    const draft = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'lifecycle rule',
      config: budgetConfig(),
      status: RuleStatus.DRAFT,
    });
    expect(draft.activated_at).toBeNull();
    await sql`UPDATE rules SET last_error = 'previous failure' WHERE id = ${draft.id}`;

    const active = await promoteRuleStatus(builderA, draft.id, RuleStatus.ACTIVE);
    expect(active?.status).toBe(RuleStatus.ACTIVE);
    expect(active?.activated_at).toBeInstanceOf(Date);
    expect(active?.last_error).toBeNull();

    const demoted = await promoteRuleStatus(builderA, draft.id, RuleStatus.DRAFT);
    expect(demoted?.status).toBe(RuleStatus.DRAFT);
    await deleteRule(builderA, draft.id);
  });

  it('retarget round-trip: cust_x -> cust_y -> all customers', async () => {
    const rule = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'retarget rule',
      customer_id: 'cust_x',
      config: budgetConfig(),
    });

    const toY = await updateRule(builderA, rule.id, { customer_id: 'cust_y' });
    expect(toY?.customer_id).toBe('cust_y');
    expect((await listActiveRulesForCustomer(builderA, 'cust_x')).map((r) => r.id)).not.toContain(
      rule.id,
    );
    expect((await listActiveRulesForCustomer(builderA, 'cust_y')).map((r) => r.id)).toContain(
      rule.id,
    );

    const toAll = await updateRule(builderA, rule.id, { customer_id: null });
    expect(toAll?.customer_id).toBeNull();
    expect((await listActiveRulesForCustomer(builderA, 'cust_x')).map((r) => r.id)).toContain(
      rule.id,
    );
    await deleteRule(builderA, rule.id);
  });

  it('toggleRule flips enabled and markRuleTriggered stamps last_triggered_at', async () => {
    const rule = await createRule({
      builder_id: builderA,
      type: RuleType.BUDGET_LIMIT,
      name: 'toggle rule',
      config: budgetConfig(),
    });
    expect(rule.last_triggered_at).toBeNull();

    const off = await toggleRule(builderA, rule.id, false);
    expect(off?.enabled).toBe(false);

    await markRuleTriggered(builderA, rule.id);
    const after = await getRule(builderA, rule.id);
    expect(after?.last_triggered_at).toBeInstanceOf(Date);

    // Cross-tenant mutations are no-ops under RLS.
    await markRuleTriggered(builderB, rule.id);
    expect(await updateRule(builderB, rule.id, { name: 'stolen' })).toBeNull();
    expect(await deleteRule(builderB, rule.id)).toBe(false);
    expect((await getRule(builderA, rule.id))?.name).toBe('toggle rule');

    await deleteRule(builderA, rule.id);
  });
});
