import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  BypassedUsageResponseSchema,
  CanonicalPostProviderCostDecimalSchema,
  CommitUsageResponseSchema,
  ReserveUsageRequestSchema,
} from '@pylva/shared';

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';
const DECISION_ID = '22222222-2222-4222-8222-222222222222';
const RESERVATION_ID = '33333333-3333-4333-8333-333333333333';

describe('integral wire-number normalization', () => {
  it('erases JavaScript negative zero to match Python and canonical JSON', () => {
    const parsed = v.safeParse(ReserveUsageRequestSchema, {
      schema_version: '1.0',
      mode: 'enforce',
      operation_id: OPERATION_ID,
      customer_id: 'customer_1',
      trace_id: '44444444-4444-4444-8444-444444444444',
      span_id: '55555555-5555-4555-8555-555555555555',
      parent_span_id: null,
      step_name: null,
      kind: 'llm',
      provider: 'openai',
      model: 'gpt-5',
      estimated_input_tokens: -0,
      max_output_tokens: -0,
    });

    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    if (parsed.output.kind !== 'llm') {
      throw new Error('expected the parsed control request to retain its LLM discriminator');
    }
    expect(parsed.output.estimated_input_tokens).toBe(0);
    expect(parsed.output.max_output_tokens).toBe(0);
    expect(Object.is(parsed.output.estimated_input_tokens, -0)).toBe(false);
    expect(Object.is(parsed.output.max_output_tokens, -0)).toBe(false);
  });
});

const bypassBase = {
  schema_version: '1.0',
  decision: 'bypassed',
  allowed: true,
  operation_id: OPERATION_ID,
  warnings: [],
} as const;
const advisoryWarning = {
  code: 'advisory_budget_exceeded',
  rule_id: '44444444-4444-4444-8444-444444444444',
  limit_usd: '1',
  projected_usd: '1.01',
} as const;

describe('BypassedUsageResponseSchema decision identity', () => {
  it('accepts a null decision_id when control is disabled', () => {
    expect(
      v.safeParse(BypassedUsageResponseSchema, {
        ...bypassBase,
        decision_id: null,
        reason: 'control_disabled',
        would_have_denied: null,
      }).success,
    ).toBe(true);
  });

  it.each([
    ['no_applicable_budget', null],
    ['shadow_would_allow', false],
    ['shadow_would_deny', true],
  ] as const)('requires a UUID decision_id for %s', (reason, wouldHaveDenied) => {
    const valid = {
      ...bypassBase,
      decision_id: DECISION_ID,
      reason,
      would_have_denied: wouldHaveDenied,
    };
    const invalid = { ...valid, decision_id: null };

    expect(v.safeParse(BypassedUsageResponseSchema, valid).success).toBe(true);
    expect(v.safeParse(BypassedUsageResponseSchema, invalid).success).toBe(false);
  });

  it.each([null, DECISION_ID])(
    'accepts a nullable decision_id for shadow_control_unavailable (%s)',
    (decisionId) => {
      expect(
        v.safeParse(BypassedUsageResponseSchema, {
          ...bypassBase,
          decision_id: decisionId,
          reason: 'shadow_control_unavailable',
          would_have_denied: null,
        }).success,
      ).toBe(true);
    },
  );

  it('rejects a decision_id when control is disabled', () => {
    expect(
      v.safeParse(BypassedUsageResponseSchema, {
        ...bypassBase,
        decision_id: DECISION_ID,
        reason: 'control_disabled',
        would_have_denied: null,
      }).success,
    ).toBe(false);
  });

  it.each([
    ['control_disabled', null],
    ['no_applicable_budget', DECISION_ID],
    ['shadow_control_unavailable', DECISION_ID],
    ['shadow_control_unavailable', null],
  ] as const)('rejects advisory warnings without evaluated allocations for %s', (reason, id) => {
    expect(
      v.safeParse(BypassedUsageResponseSchema, {
        ...bypassBase,
        decision_id: id,
        reason,
        would_have_denied: null,
        warnings: [advisoryWarning],
      }).success,
    ).toBe(false);
  });

  it.each([
    ['shadow_would_allow', false],
    ['shadow_would_deny', true],
  ] as const)('allows advisory warnings after an evaluated %s decision', (reason, denied) => {
    expect(
      v.safeParse(BypassedUsageResponseSchema, {
        ...bypassBase,
        decision_id: DECISION_ID,
        reason,
        would_have_denied: denied,
        warnings: [advisoryWarning],
      }).success,
    ).toBe(true);
  });
});

const commitBase = {
  schema_version: '1.0',
  state: 'committed',
  reservation_id: RESERVATION_ID,
  operation_id: OPERATION_ID,
  budget_exceeded_after_commit: true,
  committed_at: '2026-07-14T00:00:00.000Z',
  idempotent_replay: false,
  late: false,
} as const;

describe('CommitUsageResponseSchema settlement arithmetic', () => {
  it('allows a budget-exceeded result without per-operation overage', () => {
    const parsed = v.safeParse(CommitUsageResponseSchema, {
      ...commitBase,
      reserved_usd: '5',
      actual_usd: '5',
      released_usd: '0',
      overage_usd: '0',
    });

    expect(parsed.success).toBe(true);
  });

  it('still requires released_usd to equal reserved_usd minus actual_usd', () => {
    expect(
      v.safeParse(CommitUsageResponseSchema, {
        ...commitBase,
        reserved_usd: '10',
        actual_usd: '7',
        released_usd: '2',
        overage_usd: '0',
      }).success,
    ).toBe(false);
  });

  it('still requires overage_usd to equal actual_usd minus reserved_usd', () => {
    expect(
      v.safeParse(CommitUsageResponseSchema, {
        ...commitBase,
        reserved_usd: '7',
        actual_usd: '10',
        released_usd: '0',
        overage_usd: '2',
      }).success,
    ).toBe(false);
  });
});

describe('post-provider cost decimal precision', () => {
  it('canonicalizes the NUMERIC(44,18) maximum integer width exactly', () => {
    const parsed = v.safeParse(
      CanonicalPostProviderCostDecimalSchema,
      '99999999999999999999999999.1200',
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.output).toBe('99999999999999999999999999.12');
  });

  it('accepts all 18 fractional digits without rounding', () => {
    const value = '99999999999999999999999999.123456789012345678';
    const parsed = v.safeParse(CanonicalPostProviderCostDecimalSchema, value);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.output).toBe(value);
  });

  it.each(['100000000000000000000000000', '1.1234567890123456789', '-1', '1e2', '01'])(
    'rejects a value outside NUMERIC(44,18): %s',
    (value) => {
      expect(v.safeParse(CanonicalPostProviderCostDecimalSchema, value).success).toBe(false);
    },
  );

  it('rejects a JSON number instead of coercing it to a decimal string', () => {
    expect(v.safeParse(CanonicalPostProviderCostDecimalSchema, 1).success).toBe(false);
  });

  it('accepts widened actual and overage values after the provider runs', () => {
    const widened = '99999999999999999999999999.12';
    expect(
      v.safeParse(CommitUsageResponseSchema, {
        ...commitBase,
        reserved_usd: '0',
        actual_usd: widened,
        released_usd: '0',
        overage_usd: widened,
      }).success,
    ).toBe(true);
  });

  it('keeps reserved and released amounts on NUMERIC(38,18)', () => {
    expect(
      v.safeParse(CommitUsageResponseSchema, {
        ...commitBase,
        reserved_usd: '100000000000000000000',
        actual_usd: '100000000000000000000',
        released_usd: '0',
        overage_usd: '0',
      }).success,
    ).toBe(false);
  });
});
