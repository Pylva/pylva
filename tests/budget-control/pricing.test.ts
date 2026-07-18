import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { describe, expect, it, vi } from 'vitest';
import {
  priceAuthoritativeUsage,
  resolveAuthoritativePricing,
  type AuthoritativePricingSnapshot,
} from '../../src/lib/budget-control/pricing.js';

const BUILDER_ID = '00000000-0000-4000-8000-000000000001';
const HASH = 'a'.repeat(64);

interface CapturedQuery {
  text: string;
  values: readonly unknown[];
}

type QueryResponder = (
  query: CapturedQuery,
  index: number,
) => readonly Record<string, unknown>[] | Promise<readonly Record<string, unknown>[]>;

function createTransaction(responder: QueryResponder): {
  tx: TransactionSql;
  queries: CapturedQuery[];
  json: ReturnType<typeof vi.fn>;
} {
  const queries: CapturedQuery[] = [];
  const json = vi.fn((value: postgres.JSONValue) => ({ type: 'json', value }));
  const tag = (
    strings: TemplateStringsArray,
    ...values: readonly unknown[]
  ): Promise<readonly Record<string, unknown>[]> => {
    const query = {
      text: strings.join('?').replace(/\s+/g, ' ').trim(),
      values,
    };
    queries.push(query);
    return Promise.resolve(responder(query, queries.length - 1));
  };
  return {
    tx: Object.assign(tag, { json }) as unknown as TransactionSql,
    queries,
    json,
  };
}

const llmSnapshot: AuthoritativePricingSnapshot = {
  schema_version: '1.0',
  kind: 'llm',
  source: 'llm_pricing',
  pricing_id: '1',
  source_detail: 'admin',
  provider: 'openai',
  model: 'gpt-test',
  pricing_model: 'per_million_tokens',
  input_per_million_usd: '1',
  output_per_million_usd: '2',
  effective_from: '2026-01-01T00:00:00.000Z',
  effective_to: null,
};

const toolSnapshot: AuthoritativePricingSnapshot = {
  schema_version: '1.0',
  kind: 'tool',
  source: 'cost_sources',
  pricing_id: '00000000-0000-4000-8000-000000000002',
  source_type: 'non_llm_manual',
  tracking_status: 'tracked',
  source_status: 'healthy',
  cost_source_slug: 'browser-call',
  metric: 'browser_seconds',
  unit: 'second',
  approved_at: '2026-01-01T00:00:00.000Z',
  pricing_model: 'flat',
  unit_cost_usd: '0.1',
};

describe('authoritative pricing input boundary', () => {
  it.each([
    ['bad builder UUID', { builderId: 'not-a-uuid' }],
    ['blank provider', { usage: { provider: '   ' } }],
    ['unsafe model', { usage: { model: 'bad\u0001model' } }],
    ['fractional token count', { usage: { estimated_input_tokens: 1.5 } }],
    ['token count above uint32', { usage: { max_output_tokens: 4_294_967_296 } }],
  ])('rejects %s before querying PostgreSQL', async (_label, override) => {
    const { tx, queries } = createTransaction(() => []);
    const usage = {
      kind: 'llm' as const,
      provider: 'openai',
      model: 'gpt-test',
      estimated_input_tokens: 1,
      max_output_tokens: 1,
      ...('usage' in override ? override.usage : {}),
    };
    const result = await resolveAuthoritativePricing({
      tx,
      builderId: 'builderId' in override ? override.builderId : BUILDER_ID,
      usage,
    });

    expect(result).toEqual({
      available: false,
      reason: 'pricing_unavailable',
      cause: 'invalid_input',
    });
    expect(queries).toHaveLength(0);
  });

  it.each([
    ['bad slug', { cost_source_slug: 'Browser_Call' }],
    ['blank metric', { metric: '\u00a0' }],
    ['negative quantity', { maximum_value: '-1' }],
    ['excess scale', { maximum_value: '0.0000000000000000001' }],
    ['leading zero', { maximum_value: '01' }],
  ])('rejects tool %s before querying PostgreSQL', async (_label, override) => {
    const { tx, queries } = createTransaction(() => []);
    const result = await resolveAuthoritativePricing({
      tx,
      builderId: BUILDER_ID,
      usage: {
        kind: 'tool',
        cost_source_slug: 'browser-call',
        metric: 'browser_seconds',
        maximum_value: '1',
        ...override,
      },
    });

    expect(result).toMatchObject({ available: false, cause: 'invalid_input' });
    expect(queries).toHaveLength(0);
  });
});

describe('authoritative pricing query orchestration', () => {
  it('resolves a fresh LLM snapshot, then prices the request from that snapshot', async () => {
    const { tx, queries, json } = createTransaction((_query, index) =>
      index === 0
        ? [
            {
              outcome: 'available',
              cause: null,
              pricing_snapshot: llmSnapshot,
              pricing_snapshot_hash: HASH,
            },
          ]
        : [{ outcome: 'available', cause: null, cost_usd: '0.000003' }],
    );

    const result = await resolveAuthoritativePricing({
      tx,
      builderId: BUILDER_ID,
      usage: {
        kind: 'llm',
        provider: 'openai',
        model: 'gpt-test',
        estimated_input_tokens: 1,
        max_output_tokens: 1,
      },
    });

    expect(result).toEqual({
      available: true,
      requested_usd: '0.000003',
      pricing_snapshot: llmSnapshot,
      pricing_snapshot_hash: HASH,
    });
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain('statement_timestamp()');
    expect(queries[0]?.text).toContain('FROM custom_pricing');
    expect(queries[0]?.text).toContain('FROM llm_pricing');
    expect(queries[1]?.text).toContain('ceil(');
    expect(queries[1]?.text.match(/\bceil\(/g)).toHaveLength(1);
    expect(json).not.toHaveBeenCalled();
    expect(typeof queries[1]?.values[0]).toBe('string');
    expect(JSON.parse(queries[1]?.values[0] as string)).toEqual(llmSnapshot);
  });

  it('does not calculate a cost after resolution is unavailable', async () => {
    const { tx, queries } = createTransaction(() => [
      {
        outcome: 'unavailable',
        cause: 'ambiguous',
        pricing_snapshot: null,
        pricing_snapshot_hash: null,
      },
    ]);

    await expect(
      resolveAuthoritativePricing({
        tx,
        builderId: BUILDER_ID,
        usage: {
          kind: 'llm',
          provider: 'openai',
          model: 'gpt-test',
          estimated_input_tokens: 1,
          max_output_tokens: 1,
        },
      }),
    ).resolves.toMatchObject({ available: false, cause: 'ambiguous' });
    expect(queries).toHaveLength(1);
  });

  it('uses exact slug and metric predicates for a manual tool source', async () => {
    const { tx, queries } = createTransaction((_query, index) =>
      index === 0
        ? [
            {
              outcome: 'available',
              cause: null,
              pricing_snapshot: toolSnapshot,
              pricing_snapshot_hash: HASH,
            },
          ]
        : [{ outcome: 'available', cause: null, cost_usd: '0.1' }],
    );

    await resolveAuthoritativePricing({
      tx,
      builderId: BUILDER_ID,
      usage: {
        kind: 'tool',
        cost_source_slug: 'browser-call',
        metric: 'browser_seconds',
        maximum_value: '1.000',
      },
    });

    expect(queries[0]?.text).toContain('cs.slug = ?');
    expect(queries[0]?.text).toContain("source_type = 'non_llm_manual'");
    expect(queries[0]?.text).toContain("tracking_status = 'tracked'");
    expect(queries[1]?.text).toContain('1000000000000000000::numeric');
    expect(queries[1]?.text).toContain('tier_summary.tier_total');
    expect(queries[1]?.text.match(/\bceil\(/g)).toHaveLength(1);
  });

  it('propagates PostgreSQL operational errors instead of relabeling them as pricing misses', async () => {
    const outage = Object.assign(new Error('connection lost'), { code: '08006' });
    const { tx } = createTransaction(() => Promise.reject(outage));

    await expect(
      resolveAuthoritativePricing({
        tx,
        builderId: BUILDER_ID,
        usage: {
          kind: 'llm',
          provider: 'openai',
          model: 'gpt-test',
          estimated_input_tokens: 1,
          max_output_tokens: 1,
        },
      }),
    ).rejects.toBe(outage);
  });

  it('rejects malformed database result shapes as operational invariant failures', async () => {
    const { tx } = createTransaction(() => []);

    await expect(
      resolveAuthoritativePricing({
        tx,
        builderId: BUILDER_ID,
        usage: {
          kind: 'llm',
          provider: 'openai',
          model: 'gpt-test',
          estimated_input_tokens: 1,
          max_output_tokens: 1,
        },
      }),
    ).rejects.toThrow('exactly one row');
  });

  it.each([
    [
      'unavailable snapshot with pricing evidence',
      {
        outcome: 'unavailable',
        cause: 'not_found',
        pricing_snapshot: llmSnapshot,
        pricing_snapshot_hash: HASH,
      },
      'contradictory unavailable evidence',
    ],
    [
      'available snapshot with an unavailable cause',
      {
        outcome: 'available',
        cause: 'not_found',
        pricing_snapshot: llmSnapshot,
        pricing_snapshot_hash: HASH,
      },
      'cause for available pricing',
    ],
  ])('rejects a contradictory result: %s', async (_label, row, message) => {
    const { tx } = createTransaction(() => [row]);

    await expect(
      resolveAuthoritativePricing({
        tx,
        builderId: BUILDER_ID,
        usage: {
          kind: 'llm',
          provider: 'openai',
          model: 'gpt-test',
          estimated_input_tokens: 1,
          max_output_tokens: 1,
        },
      }),
    ).rejects.toThrow(message);
  });
});

describe('stored-snapshot cost calculation boundary', () => {
  it('rejects a hash mismatch result and preserves the database cause', async () => {
    const { tx } = createTransaction(() => [
      { outcome: 'unavailable', cause: 'malformed', cost_usd: null },
    ]);

    await expect(
      priceAuthoritativeUsage({
        tx,
        pricing_snapshot: llmSnapshot,
        pricing_snapshot_hash: HASH,
        usage: { kind: 'llm', input_tokens: 1, output_tokens: 1 },
        amount_kind: 'actual',
      }),
    ).resolves.toEqual({
      available: false,
      reason: 'pricing_unavailable',
      cause: 'malformed',
    });
  });

  it('rejects kind mismatch and invalid actual quantities before querying', async () => {
    const { tx, queries } = createTransaction(() => []);

    await expect(
      priceAuthoritativeUsage({
        tx,
        pricing_snapshot: toolSnapshot,
        pricing_snapshot_hash: HASH,
        usage: { kind: 'llm', input_tokens: 1, output_tokens: 1 },
        amount_kind: 'actual',
      }),
    ).resolves.toMatchObject({ available: false, cause: 'malformed' });
    await expect(
      priceAuthoritativeUsage({
        tx,
        pricing_snapshot: toolSnapshot,
        pricing_snapshot_hash: HASH,
        usage: { kind: 'tool', value: '1e3' },
        amount_kind: 'actual',
      }),
    ).resolves.toMatchObject({ available: false, cause: 'invalid_input' });
    expect(queries).toHaveLength(0);
  });

  it.each([
    [
      'unavailable result carrying a cost',
      { outcome: 'unavailable', cause: 'out_of_range', cost_usd: '1' },
      'contradictory unavailable evidence',
    ],
    [
      'available result carrying a cause',
      { outcome: 'available', cause: 'out_of_range', cost_usd: '1' },
      'invalid result',
    ],
    [
      'requested result outside NUMERIC(38,18)',
      {
        outcome: 'available',
        cause: null,
        cost_usd: '100000000000000000000',
      },
      'invalid result',
    ],
    [
      'non-canonical available decimal',
      { outcome: 'available', cause: null, cost_usd: '1.0' },
      'invalid result',
    ],
  ])('rejects a contradictory or unsafe cost result: %s', async (_label, row, message) => {
    const { tx } = createTransaction(() => [row]);

    await expect(
      priceAuthoritativeUsage({
        tx,
        pricing_snapshot: llmSnapshot,
        pricing_snapshot_hash: HASH,
        usage: { kind: 'llm', input_tokens: 1, output_tokens: 1 },
        amount_kind: 'requested',
      }),
    ).rejects.toThrow(message);
  });
});
