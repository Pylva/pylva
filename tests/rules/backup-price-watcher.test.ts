// D31 — pure-unit coverage of the watcher's decision functions plus a
// mocked end-to-end pass through `runBackupPriceWatcher`.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  RuleStatus,
  RuleType,
  WebhookEventType,
  type ReliabilityFailoverConfig,
} from '@pylva/shared';

vi.mock('../../src/lib/db/client.js', () => ({
  db: { execute: vi.fn() },
}));
vi.mock('../../src/lib/alerts/builder-alert.js', () => ({
  deliverBuilderAlert: vi.fn(),
}));
vi.mock('../../src/lib/rules/backup-price-snapshot.js', () => ({
  fetchActiveBackupPrice: vi.fn(),
}));
vi.mock('../../src/lib/logger.js', () => ({
  logger: { child: () => ({ warn: vi.fn(), info: vi.fn() }) },
}));

const watcher = await import('../../src/lib/rules/backup-price-watcher.js');
const { db } = await import('../../src/lib/db/client.js');
const { deliverBuilderAlert } = await import('../../src/lib/alerts/builder-alert.js');
const { fetchActiveBackupPrice } = await import('../../src/lib/rules/backup-price-snapshot.js');

const dbExecute = vi.mocked(db.execute);
const deliverMock = vi.mocked(deliverBuilderAlert);
const fetchPriceMock = vi.mocked(fetchActiveBackupPrice);

const SNAPSHOTTED_CFG: ReliabilityFailoverConfig = {
  customer_id: 'cust-1',
  primary_provider: 'openai',
  backup_provider: 'anthropic',
  backup_model: 'claude-3-5-sonnet',
  enabled: true,
  consent_to_cost_shift: true,
  trigger_error_rate_pct: 10,
  window_seconds: 300,
  recover_error_rate_pct: 5,
  recover_after_seconds: 300,
  recovery_probe_after_seconds: 1800,
  consent_backup_input_per_1m_usd: 3.0,
  consent_backup_output_per_1m_usd: 15.0,
  consent_observed_at: '2026-04-01T00:00:00.000Z',
};

describe('evaluateRule', () => {
  it('returns no_snapshot when backup_model is missing', () => {
    const cfg = { ...SNAPSHOTTED_CFG, backup_model: undefined };
    expect(watcher.evaluateRule(cfg)).toBe('no_snapshot');
  });

  it('returns no_snapshot when consent prices are missing', () => {
    const cfg = { ...SNAPSHOTTED_CFG, consent_backup_input_per_1m_usd: undefined };
    expect(watcher.evaluateRule(cfg)).toBe('no_snapshot');
  });

  it('returns check when backup_model + snapshot both present', () => {
    expect(watcher.evaluateRule(SNAPSHOTTED_CFG)).toBe('check');
  });
});

describe('computeDeltaPct', () => {
  it('returns positive % when current sum > consent sum', () => {
    expect(watcher.computeDeltaPct(SNAPSHOTTED_CFG, 4.0, 16.0)).toBeCloseTo(11.11, 2);
  });

  it('returns negative % when current < consent', () => {
    expect(watcher.computeDeltaPct(SNAPSHOTTED_CFG, 2.0, 13.0)).toBeCloseTo(-16.67, 2);
  });

  it('returns 0 when consent sum is 0 (defensive)', () => {
    const cfg = {
      ...SNAPSHOTTED_CFG,
      consent_backup_input_per_1m_usd: 0,
      consent_backup_output_per_1m_usd: 0,
    };
    expect(watcher.computeDeltaPct(cfg, 1, 1)).toBe(0);
  });
});

describe('runBackupPriceWatcher', () => {
  beforeEach(() => {
    dbExecute.mockReset();
    deliverMock.mockReset();
    fetchPriceMock.mockReset();
  });

  it('dispatches when delta exceeds 10%', async () => {
    dbExecute.mockResolvedValue([
      {
        id: 'r-1',
        builder_id: 'b-1',
        config: SNAPSHOTTED_CFG as unknown as Record<string, unknown>,
      },
    ] as never);
    fetchPriceMock.mockResolvedValue({
      input_per_1m_usd: 4.0,
      output_per_1m_usd: 16.0,
      observed_at: '',
    });

    const result = await watcher.runBackupPriceWatcher();

    expect(result.alerts_dispatched).toBe(1);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const call = deliverMock.mock.calls[0]![0];
    expect(call.builderId).toBe('b-1');
    expect(call.payload.type).toBe(WebhookEventType.BACKUP_MODEL_PRICE_CHANGED);
  });

  it('does not dispatch when delta is below 10%', async () => {
    dbExecute.mockResolvedValue([
      {
        id: 'r-1',
        builder_id: 'b-1',
        config: SNAPSHOTTED_CFG as unknown as Record<string, unknown>,
      },
    ] as never);
    fetchPriceMock.mockResolvedValue({
      input_per_1m_usd: 3.1,
      output_per_1m_usd: 15.5,
      observed_at: '',
    });

    const result = await watcher.runBackupPriceWatcher();

    expect(result.alerts_dispatched).toBe(0);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('skips rules with no consent snapshot', async () => {
    const cfg = { ...SNAPSHOTTED_CFG, consent_backup_input_per_1m_usd: undefined };
    dbExecute.mockResolvedValue([
      { id: 'r-1', builder_id: 'b-1', config: cfg as unknown as Record<string, unknown> },
    ] as never);

    const result = await watcher.runBackupPriceWatcher();

    expect(result.skipped_no_snapshot).toBe(1);
    expect(result.alerts_dispatched).toBe(0);
    expect(fetchPriceMock).not.toHaveBeenCalled();
  });

  it('counts skipped_no_pricing when fetchActiveBackupPrice returns null', async () => {
    dbExecute.mockResolvedValue([
      {
        id: 'r-1',
        builder_id: 'b-1',
        config: SNAPSHOTTED_CFG as unknown as Record<string, unknown>,
      },
    ] as never);
    fetchPriceMock.mockResolvedValue(null);

    const result = await watcher.runBackupPriceWatcher();

    expect(result.skipped_no_pricing).toBe(1);
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('isolates errors per rule', async () => {
    dbExecute.mockResolvedValue([
      {
        id: 'r-1',
        builder_id: 'b-1',
        config: SNAPSHOTTED_CFG as unknown as Record<string, unknown>,
      },
      {
        id: 'r-2',
        builder_id: 'b-2',
        config: SNAPSHOTTED_CFG as unknown as Record<string, unknown>,
      },
    ] as never);
    fetchPriceMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ input_per_1m_usd: 4.0, output_per_1m_usd: 16.0, observed_at: '' });

    const result = await watcher.runBackupPriceWatcher();

    expect(result.errors).toBe(1);
    expect(result.alerts_dispatched).toBe(1);
  });
});

describe('rules.type filter', () => {
  beforeEach(() => {
    dbExecute.mockReset();
  });

  it('queries only active+enabled reliability_failover rules', async () => {
    dbExecute.mockResolvedValue([] as never);
    await watcher.runBackupPriceWatcher();
    expect(dbExecute).toHaveBeenCalledTimes(1);
    const sqlChunk = JSON.stringify(dbExecute.mock.calls[0]?.[0]);
    expect(sqlChunk).toContain(RuleType.RELIABILITY_FAILOVER);
    expect(sqlChunk).toContain(RuleStatus.ACTIVE);
  });
});
