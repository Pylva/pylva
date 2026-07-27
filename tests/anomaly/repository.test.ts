// B4-4b — Repository idempotency contract. Verifies that
// `insertAnomalyEvent` returns the inserted row on first call, and
// `null` (not throw) when the partial unique index from migration 030
// rejects a duplicate open anomaly. Drizzle is mocked so the test
// asserts the contract without a live Postgres.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  AnomalyRecommendationAction,
  AnomalySeverity,
  AnomalySourceType,
  AnomalyStatus,
} from '@pylva/shared';

const mocks = vi.hoisted(() => ({
  getBuilderEntitlementForShare: vi.fn(),
  txInsertReturning: vi.fn(),
}));

const tx = {
  insert: () => ({
    values: () => ({
      onConflictDoNothing: () => ({
        returning: mocks.txInsertReturning,
      }),
    }),
  }),
};

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: async (_builderId: string, cb: (tx: unknown) => Promise<unknown>) =>
    cb(tx),
}));

vi.mock('../../src/lib/db/advisory-locks.js', () => ({
  getBuilderEntitlementForShare: mocks.getBuilderEntitlementForShare,
}));

const { insertAnomalyEvent } = await import('../../src/lib/anomaly/repository.js');

const BASE_INPUT = {
  builder_id: '00000000-0000-0000-0000-000000000001',
  customer_id: 'cust-1',
  source_type: AnomalySourceType.COST_SPIKE,
  severity: AnomalySeverity.WARN,
  period_start: new Date('2026-04-25T00:00:00Z'),
  period_end: new Date('2026-04-26T00:00:00Z'),
  actual_value: 120,
  baseline_value: 100,
  delta_pct: 20,
  diagnosis: { top_drivers: [] },
  recommendation: { action: AnomalyRecommendationAction.INVESTIGATE_DEEP_LINK },
};

describe('insertAnomalyEvent', () => {
  beforeEach(() => {
    mocks.txInsertReturning.mockReset();
    mocks.getBuilderEntitlementForShare.mockReset().mockResolvedValue({
      ok: true,
      entitlement: {
        plan: 'pro',
        access_state: 'active',
        entitlement_source: 'stripe',
        has_product_access: true,
        legacy_free: false,
      },
    });
  });

  it('returns the inserted row on first insert', async () => {
    const fakeRow = {
      id: 'a-1',
      builder_id: BASE_INPUT.builder_id,
      customer_id: BASE_INPUT.customer_id,
      source_type: BASE_INPUT.source_type,
      status: AnomalyStatus.OPEN,
      severity: AnomalySeverity.WARN,
      period_start: BASE_INPUT.period_start,
      period_end: BASE_INPUT.period_end,
      actual_value: '120',
      baseline_value: '100',
      delta_pct: '20',
      diagnosis: BASE_INPUT.diagnosis,
      recommendation: BASE_INPUT.recommendation,
      created_at: new Date(),
      dismissed_at: null,
    };
    mocks.txInsertReturning.mockResolvedValue([fakeRow]);

    const result = await insertAnomalyEvent(BASE_INPUT);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('a-1');
    expect(result!.actual_value).toBe(120);
    expect(result!.delta_pct).toBe(20);
    expect(mocks.getBuilderEntitlementForShare).toHaveBeenCalledWith(
      tx,
      BASE_INPUT.builder_id,
    );
  });

  it('returns null when ON CONFLICT DO NOTHING swallows the insert', async () => {
    // ON CONFLICT DO NOTHING + RETURNING yields zero rows when the
    // partial unique index rejects the row.
    mocks.txInsertReturning.mockResolvedValue([]);

    const result = await insertAnomalyEvent(BASE_INPUT);
    expect(result).toBeNull();
  });

  it('does not insert when the lifecycle row is restricted inside the transaction', async () => {
    mocks.getBuilderEntitlementForShare.mockResolvedValue({
      ok: true,
      entitlement: {
        plan: null,
        access_state: 'suspended',
        entitlement_source: 'stripe',
        has_product_access: false,
        legacy_free: false,
      },
    });

    await expect(insertAnomalyEvent(BASE_INPUT)).rejects.toMatchObject({
      code: 'product_access_mutation_denied',
    });
    expect(mocks.txInsertReturning).not.toHaveBeenCalled();
  });
});
