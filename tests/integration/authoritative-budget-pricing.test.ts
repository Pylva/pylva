import { randomBytes } from 'node:crypto';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  priceAuthoritativeUsage,
  resolveAuthoritativePricing,
  type AuthoritativePricingResolved,
  type AuthoritativePricingSnapshot,
} from '../../src/lib/budget-control/pricing.js';
import { applyMigrationsThrough, createScratchDb, type ScratchDb } from '../helpers/scratch-db.js';

let scratch: ScratchDb | undefined;
let builderId = '';

async function inBuilderTransaction<T>(callback: (tx: TransactionSql) => Promise<T>): Promise<T> {
  if (!scratch) throw new Error('scratch database is not initialized');
  return (await scratch.sql.begin(async (tx) => {
    await tx`SELECT set_config('app.builder_id', ${builderId}, true)`;
    return callback(tx);
  })) as T;
}

async function expectResolved(
  value: Awaited<ReturnType<typeof resolveAuthoritativePricing>>,
): Promise<AuthoritativePricingResolved> {
  expect(value.available).toBe(true);
  if (!value.available) throw new Error(`expected pricing, got ${value.cause}`);
  return value;
}

async function insertCostSource(
  tx: TransactionSql,
  overrides: Partial<{
    approvedAt: string | null;
    metric: string | null;
    price: string | null;
    slug: string;
    sourceType: 'llm_provider' | 'non_llm_manual';
    tiers: postgres.JSONValue;
    trackingStatus: 'ignored' | 'pending' | 'tracked';
  }> = {},
): Promise<void> {
  const tiers = Object.prototype.hasOwnProperty.call(overrides, 'tiers') ? overrides.tiers : null;
  await tx`
    INSERT INTO cost_sources (
      builder_id, source_type, display_name, slug, metric, unit,
      price_per_unit, pricing_tiers, status, approved_at, tracking_status
    ) VALUES (
      ${builderId}::uuid,
      ${overrides.sourceType ?? 'non_llm_manual'},
      'Browser call',
      ${overrides.slug ?? 'browser-call'},
      ${overrides.metric === undefined ? 'browser_seconds' : overrides.metric},
      'second',
      ${overrides.price === undefined ? '0.1' : overrides.price}::numeric,
      ${tiers === null || tiers === undefined ? null : tx.json(tiers)}::jsonb,
      'healthy',
      ${overrides.approvedAt === undefined ? '2026-01-01T00:00:00.000Z' : overrides.approvedAt}::timestamptz,
      ${overrides.trackingStatus ?? 'tracked'}
    )
  `;
}

beforeAll(async () => {
  scratch = await createScratchDb({ prefix: 'pylva_authoritative_pricing' });
  try {
    await applyMigrationsThrough(scratch, '050');
    const suffix = randomBytes(6).toString('hex');
    const [builder] = await scratch.sql<{ id: string }[]>`
      INSERT INTO builders (email, name, tier, slug)
      VALUES (
        ${`pricing-${suffix}@example.com`},
        'Authoritative pricing test',
        'pro',
        ${`pricing-${suffix}`}
      )
      RETURNING id
    `;
    builderId = builder!.id;
  } catch (error) {
    await scratch.drop();
    scratch = undefined;
    throw error;
  }
}, 60_000);

beforeEach(async () => {
  if (!scratch) throw new Error('scratch database is not initialized');
  await scratch.sql`DELETE FROM custom_pricing WHERE builder_id = ${builderId}::uuid`;
  await scratch.sql`DELETE FROM cost_sources WHERE builder_id = ${builderId}::uuid`;
  await scratch.sql`DELETE FROM llm_pricing`;
});

afterAll(async () => {
  if (scratch) await scratch.drop();
  scratch = undefined;
});

describe('authoritative LLM pricing against PostgreSQL', () => {
  it('prefers one active custom row and calculates exact per-million token cost', async () => {
    await inBuilderTransaction(async (tx) => {
      await tx`
        INSERT INTO llm_pricing (
          provider, model, input_per_1m, output_per_1m, effective_from, source
        ) VALUES ('openai', 'gpt-test', 100, 100, NOW() - INTERVAL '1 day', 'admin')
      `;
      await tx`
        INSERT INTO custom_pricing (
          builder_id, provider, model, price_per_unit_usd,
          input_per_1m_usd, output_per_1m_usd, effective_from, source
        ) VALUES (
          ${builderId}::uuid, 'openai', 'gpt-test', 0,
          2, 4, NOW() - INTERVAL '1 hour', 'builder_manual'
        )
      `;

      const result = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'openai',
            model: 'gpt-test',
            estimated_input_tokens: 500_000,
            max_output_tokens: 250_000,
          },
        }),
      );

      expect(result.requested_usd).toBe('2');
      expect(result.pricing_snapshot).toMatchObject({
        source: 'custom_pricing',
        input_per_million_usd: '2',
        output_per_million_usd: '4',
      });
      const [hash] = await tx<{ value: string }[]>`
        SELECT public.pylva_budget_jsonb_sha256(
          ${tx.json(result.pricing_snapshot)}::jsonb
        ) AS value
      `;
      expect(result.pricing_snapshot_hash).toBe(hash!.value);

      await tx`
        UPDATE custom_pricing
        SET input_per_1m_usd = 200, output_per_1m_usd = 400
        WHERE builder_id = ${builderId}::uuid
          AND provider = 'openai'
          AND model = 'gpt-test'
      `;
      await expect(
        priceAuthoritativeUsage({
          tx,
          pricing_snapshot: result.pricing_snapshot,
          pricing_snapshot_hash: result.pricing_snapshot_hash,
          usage: { kind: 'llm', input_tokens: 500_000, output_tokens: 250_000 },
          amount_kind: 'actual',
        }),
      ).resolves.toEqual({ available: true, cost_usd: '2' });
    });
  });

  it('preserves exact LLM precision at maximum tokens and accepted frozen rates', async () => {
    await inBuilderTransaction(async (tx) => {
      await tx`
        INSERT INTO custom_pricing (
          builder_id, provider, model, price_per_unit_usd,
          input_per_1m_usd, output_per_1m_usd, effective_from, source
        ) VALUES (
          ${builderId}::uuid, 'openai', 'gpt-precision-boundary', 0,
          99999999.9999999999, 0, NOW() - INTERVAL '1 hour', 'builder_manual'
        )
      `;

      const maximumTokens = 4_294_967_295;
      const resolved = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'openai',
            model: 'gpt-precision-boundary',
            estimated_input_tokens: maximumTokens,
            max_output_tokens: 0,
          },
        }),
      );
      expect(resolved.requested_usd).toBe('429496729499.9999995705032705');

      const maximumAcceptedSnapshot: AuthoritativePricingSnapshot = {
        ...resolved.pricing_snapshot,
        input_per_million_usd: '99999999999999.9999999999',
      };
      const [hash] = await tx<{ value: string }[]>`
        SELECT public.pylva_budget_jsonb_sha256(
          ${tx.json(maximumAcceptedSnapshot)}::jsonb
        ) AS value
      `;
      await expect(
        priceAuthoritativeUsage({
          tx,
          pricing_snapshot: maximumAcceptedSnapshot,
          pricing_snapshot_hash: hash!.value,
          usage: { kind: 'llm', input_tokens: maximumTokens, output_tokens: 0 },
          amount_kind: 'actual',
        }),
      ).resolves.toEqual({
        available: true,
        cost_usd: '429496729499999999.9999995705032705',
      });
    });
  });

  it('ignores a future custom row and uses the deterministic server-active global row', async () => {
    await inBuilderTransaction(async (tx) => {
      await tx`
        INSERT INTO llm_pricing (
          provider, model, input_per_1m, output_per_1m, effective_from, source
        ) VALUES ('openai', 'gpt-test', 1.2345, 2.3456, NOW() - INTERVAL '1 day', 'auto')
      `;
      await tx`
        INSERT INTO custom_pricing (
          builder_id, provider, model, price_per_unit_usd,
          input_per_1m_usd, output_per_1m_usd, effective_from, source
        ) VALUES (
          ${builderId}::uuid, 'openai', 'gpt-test', 0,
          99, 99, NOW() + INTERVAL '1 day', 'builder_manual'
        )
      `;

      const result = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'openai',
            model: 'gpt-test',
            estimated_input_tokens: 1,
            max_output_tokens: 1,
          },
        }),
      );

      expect(result.requested_usd).toBe('0.0000035801');
      expect(result.pricing_snapshot).toMatchObject({ source: 'llm_pricing' });
    });
  });

  it('fails closed on active custom ambiguity without falling back globally', async () => {
    await inBuilderTransaction(async (tx) => {
      await tx`
        INSERT INTO llm_pricing (
          provider, model, input_per_1m, output_per_1m, effective_from, source
        ) VALUES ('openai', 'gpt-test', 1, 1, NOW() - INTERVAL '3 days', 'admin')
      `;
      await tx`
        INSERT INTO custom_pricing (
          builder_id, provider, model, price_per_unit_usd, effective_from, effective_to, source
        ) VALUES
          (${builderId}::uuid, 'openai', 'gpt-test', 0.000001, NOW() - INTERVAL '2 days', NOW() + INTERVAL '2 days', 'builder_manual'),
          (${builderId}::uuid, 'openai', 'gpt-test', 0.000002, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'builder_manual')
      `;

      await expect(
        resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'openai',
            model: 'gpt-test',
            estimated_input_tokens: 1,
            max_output_tokens: 1,
          },
        }),
      ).resolves.toMatchObject({ available: false, cause: 'ambiguous' });
    });
  });

  it('fails closed on ambiguous global rows and malformed custom numeric values', async () => {
    await inBuilderTransaction(async (tx) => {
      await tx`
        INSERT INTO llm_pricing (
          provider, model, input_per_1m, output_per_1m,
          effective_from, effective_to, source
        ) VALUES
          ('openai', 'global-ambiguous', 1, 1, NOW() - INTERVAL '2 days', NOW() + INTERVAL '2 days', 'admin'),
          ('openai', 'global-ambiguous', 2, 2, NOW() - INTERVAL '1 day', NOW() + INTERVAL '1 day', 'admin')
      `;
      await expect(
        resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'openai',
            model: 'global-ambiguous',
            estimated_input_tokens: 1,
            max_output_tokens: 1,
          },
        }),
      ).resolves.toMatchObject({ available: false, cause: 'ambiguous' });

      await tx`
        INSERT INTO custom_pricing (
          builder_id, provider, model, price_per_unit_usd, effective_from, source
        ) VALUES (
          ${builderId}::uuid, 'openai', 'bad-custom', 'NaN'::numeric,
          NOW() - INTERVAL '1 hour', 'builder_manual'
        )
      `;
      await expect(
        resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'openai',
            model: 'bad-custom',
            estimated_input_tokens: 1,
            max_output_tokens: 1,
          },
        }),
      ).resolves.toMatchObject({ available: false, cause: 'malformed' });
    });
  });

  it('treats a real zero price as available', async () => {
    await inBuilderTransaction(async (tx) => {
      await tx`
        INSERT INTO llm_pricing (
          provider, model, input_per_1m, output_per_1m, effective_from, source
        ) VALUES ('local', 'free-model', 0, 0, NOW() - INTERVAL '1 day', 'admin')
      `;
      const result = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'llm',
            provider: 'local',
            model: 'free-model',
            estimated_input_tokens: 4_294_967_295,
            max_output_tokens: 4_294_967_295,
          },
        }),
      );
      expect(result.requested_usd).toBe('0');
    });
  });
});

describe('authoritative non-LLM pricing against PostgreSQL', () => {
  it('prices an approved tracked manual flat source by exact slug and metric', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, { price: '0.1' });
      const result = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '2.5000',
          },
        }),
      );
      expect(result.requested_usd).toBe('0.25');
      expect(result.pricing_snapshot).toMatchObject({
        source_type: 'non_llm_manual',
        tracking_status: 'tracked',
        pricing_model: 'flat',
        unit_cost_usd: '0.1',
      });
      await expect(
        priceAuthoritativeUsage({
          tx,
          pricing_snapshot: result.pricing_snapshot,
          pricing_snapshot_hash: result.pricing_snapshot_hash,
          usage: { kind: 'tool', value: '2.5' },
          amount_kind: 'actual',
        }),
      ).resolves.toEqual({ available: true, cost_usd: result.requested_usd });
    });
  });

  it.each([
    ['ignored', { trackingStatus: 'ignored' as const }],
    ['pending', { trackingStatus: 'pending' as const }],
    ['unapproved', { approvedAt: null }],
    ['future-approved', { approvedAt: '2999-01-01T00:00:00.000Z' }],
    ['wrong source type', { sourceType: 'llm_provider' as const }],
    ['metric mismatch', { metric: 'another_metric' }],
  ])('does not authorize a %s source', async (_label, override) => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, override);
      await expect(
        resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '1',
          },
        }),
      ).resolves.toMatchObject({ available: false, cause: 'not_found' });
    });
  });

  it('walks validated contiguous volume tiers with exact graduated arithmetic', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, {
        price: null,
        tiers: [
          { from: 0, to: 10, price: 0.1 },
          { from: 10, to: null, price: 0.2 },
        ],
      });
      const result = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '15',
          },
        }),
      );
      expect(result.requested_usd).toBe('2');
      expect(result.pricing_snapshot['tiers']).toEqual([
        { from: '0', to: '10', price_per_unit_usd: '0.1' },
        { from: '10', to: null, price_per_unit_usd: '0.2' },
      ]);
    });
  });

  it('ceil-rounds the exact tier sum once and remains monotonic for smaller actual usage', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, {
        price: null,
        tiers: [
          { from: 0, to: 0.0000000000004, price: 0.000001 },
          { from: 0.0000000000004, to: null, price: 0.000001 },
        ],
      });
      const maximum = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '0.0000000000008',
          },
        }),
      );

      // Each tier contributes 0.4 attodollars. Per-tier ceiling would return
      // 0.000000000000000002; one ceiling after the exact sum returns one.
      expect(maximum.requested_usd).toBe('0.000000000000000001');
      await expect(
        priceAuthoritativeUsage({
          tx,
          pricing_snapshot: maximum.pricing_snapshot,
          pricing_snapshot_hash: maximum.pricing_snapshot_hash,
          usage: { kind: 'tool', value: '0.0000000000004' },
          amount_kind: 'actual',
        }),
      ).resolves.toEqual({ available: true, cost_usd: '0.000000000000000001' });
    });
  });

  it.each([
    [
      'gap',
      [
        { from: 0, to: 10, price: 1 },
        { from: 11, to: null, price: 1 },
      ],
    ],
    [
      'overlap',
      [
        { from: 0, to: 10, price: 1 },
        { from: 9, to: null, price: 1 },
      ],
    ],
    [
      'non-final open tier',
      [
        { from: 0, to: null, price: 1 },
        { from: 10, to: 20, price: 1 },
      ],
    ],
    ['rate above NUMERIC(12,6)', [{ from: 0, to: null, price: 1_000_000 }]],
    ['negative rate', [{ from: 0, to: null, price: -1 }]],
    ['rate with excess scale', [{ from: 0, to: null, price: 0.0000001 }]],
    ['first tier not starting at zero', [{ from: 1, to: null, price: 1 }]],
    ['zero-width closed tier', [{ from: 0, to: 0, price: 1 }]],
    ['boundary above NUMERIC(38,18)', [{ from: 0, to: 1e20, price: 1 }]],
    ['unexpected tier property', [{ from: 0, to: null, price: 1, currency: 'USD' }]],
    ['non-array JSON', { from: 0, to: null, price: 1 }],
    ['empty array', []],
  ])('fails closed for a malformed tier table: %s', async (_label, tiers) => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, { price: null, tiers });
      await expect(
        resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '1',
          },
        }),
      ).resolves.toMatchObject({ available: false, cause: 'malformed' });
    });
  });

  it('returns unpriced when a valid closed tier table does not cover the quantity', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, {
        price: null,
        tiers: [{ from: 0, to: 10, price: 1 }],
      });
      await expect(
        resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '10.000000000000000001',
          },
        }),
      ).resolves.toMatchObject({ available: false, cause: 'not_found' });
    });
  });

  it('applies one conservative ceiling after exact arithmetic and treats zero as valid', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, { price: '0.000001' });
      const positive = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '0.000000000000000001',
          },
        }),
      );
      expect(positive.requested_usd).toBe('0.000000000000000001');

      const zero = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '0',
          },
        }),
      );
      expect(zero.requested_usd).toBe('0');

      await tx`
        UPDATE cost_sources
        SET price_per_unit = 0
        WHERE builder_id = ${builderId}::uuid AND slug = 'browser-call'
      `;
      const free = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '99999999999999999999.999999999999999999',
          },
        }),
      );
      expect(free.requested_usd).toBe('0');
    });
  });

  it('enforces NUMERIC(38,18) before dispatch but preserves NUMERIC(44,18) actual cost', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, { price: '999999.999999' });
      const seed = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '1',
          },
        }),
      );
      const maximumQuantity = '99999999999999999999.999999999999999999';

      await expect(
        priceAuthoritativeUsage({
          tx,
          pricing_snapshot: seed.pricing_snapshot,
          pricing_snapshot_hash: seed.pricing_snapshot_hash,
          usage: { kind: 'tool', value: maximumQuantity },
          amount_kind: 'requested',
        }),
      ).resolves.toMatchObject({ available: false, cause: 'out_of_range' });

      const actual = await priceAuthoritativeUsage({
        tx,
        pricing_snapshot: seed.pricing_snapshot,
        pricing_snapshot_hash: seed.pricing_snapshot_hash,
        usage: { kind: 'tool', value: maximumQuantity },
        amount_kind: 'actual',
      });
      expect(actual.available).toBe(true);
      if (actual.available) {
        // PostgreSQL numeric division can discard fractional scale at this
        // magnitude. The production expression multiplies the integer ceiling
        // by exactly 1e-18 so the one-ceil result remains exact.
        expect(actual.cost_usd).toBe('99999999999899999999999999.999999999999000001');
        expect(actual.cost_usd.split('.')[0]).toHaveLength(26);
      }
    });
  });

  it('revalidates the stored PostgreSQL hash and snapshot formula at settlement', async () => {
    await inBuilderTransaction(async (tx) => {
      await insertCostSource(tx, { price: '0.1' });
      const seed = await expectResolved(
        await resolveAuthoritativePricing({
          tx,
          builderId,
          usage: {
            kind: 'tool',
            cost_source_slug: 'browser-call',
            metric: 'browser_seconds',
            maximum_value: '1',
          },
        }),
      );
      const tampered: AuthoritativePricingSnapshot = {
        ...seed.pricing_snapshot,
        unit_cost_usd: '0.2',
      };
      await expect(
        priceAuthoritativeUsage({
          tx,
          pricing_snapshot: tampered,
          pricing_snapshot_hash: seed.pricing_snapshot_hash,
          usage: { kind: 'tool', value: '1' },
          amount_kind: 'actual',
        }),
      ).resolves.toMatchObject({ available: false, cause: 'malformed' });
    });
  });
});
