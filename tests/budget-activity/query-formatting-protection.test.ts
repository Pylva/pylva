import { describe, expect, it } from 'vitest';
import {
  BudgetActivityQueryError,
  budgetActivityQueryToSearchParams,
  parseBudgetActivityQuery,
} from '../../src/lib/budget-activity/query.js';
import { deriveCostSourceProtectionState } from '../../src/lib/cost-sources/protection.js';
import { formatTelemetryUsd, formatUsd } from '../../src/lib/formatting.js';
import { BUDGET_FIXTURE_IDS } from '../_helpers/budget-activity-fixtures.js';

describe('budget activity query contract', () => {
  it('uses bounded, stable defaults', () => {
    expect(parseBudgetActivityQuery(new URLSearchParams())).toEqual({
      status: 'all',
      kind: 'all',
      customer: null,
      source: null,
      trace_id: null,
      rule_key: null,
      page: 1,
      page_size: 25,
    });
  });

  it('normalizes a complete query and serializes it losslessly', () => {
    const params = new URLSearchParams({
      status: 'refused',
      kind: 'tool',
      customer: 'end_user_42',
      source: ' Tavily ',
      trace_id: BUDGET_FIXTURE_IDS.trace.toUpperCase(),
      rule_key: BUDGET_FIXTURE_IDS.rule.toUpperCase(),
      page: '3',
      page_size: '100',
    });
    const query = parseBudgetActivityQuery(params);
    expect(query).toMatchObject({
      status: 'refused',
      kind: 'tool',
      customer: 'end_user_42',
      source: 'Tavily',
      trace_id: BUDGET_FIXTURE_IDS.trace,
      rule_key: BUDGET_FIXTURE_IDS.rule,
      page: 3,
      page_size: 100,
    });
    expect(parseBudgetActivityQuery(budgetActivityQueryToSearchParams(query))).toEqual(query);
  });

  it.each([
    ['status=unknown', 'status'],
    ['kind=database', 'kind'],
    ['customer=bad%20id', 'customer'],
    ['source=%00', 'source'],
    ['trace_id=nope', 'trace_id'],
    ['rule_key=nope', 'rule_key'],
    ['page=0', 'page'],
    ['page=100001', 'page'],
    ['page_size=101', 'page_size'],
    ['page_size=1.5', 'page_size'],
  ])('rejects malformed filter %s', (raw, param) => {
    expect(() => parseBudgetActivityQuery(new URLSearchParams(raw))).toThrow(
      expect.objectContaining<Partial<BudgetActivityQueryError>>({ param }),
    );
  });
});

describe('adaptive telemetry currency', () => {
  it.each([
    [0, '$0.00'],
    [-0, '$0.00'],
    ['-0.000000000000000000', '$0.00'],
    ['0.005', '$0.005'],
    ['0.009999999999999999', '$0.009999999999999999'],
    ['0.0000042', '$0.0000042'],
    ['0.000000000000000001', '$0.000000000000000001'],
    ['1e-18', '$0.000000000000000001'],
    ['1e-19', '$1.00e-19'],
    [-0.0042, '-$0.0042'],
    [1.239, '$1.24'],
    ['99999999999999999999999999.123456789012345678', '$99,999,999,999,999,999,999,999,999.12'],
  ])('formats %s as %s', (value, expected) => {
    expect(formatTelemetryUsd(value)).toBe(expected);
  });

  it('never renders a finite nonzero telemetry value as zero', () => {
    expect(formatTelemetryUsd(1e-19)).toBe('$1.00e-19');
    expect(formatTelemetryUsd(1e-19)).not.toBe('$0.00');
  });

  it('keeps invoice currency on the two-decimal formatter', () => {
    expect(formatUsd(0.0042)).toBe('$0.00');
    expect(formatUsd(0.009999999999999999)).toBe('$0.01');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, '', ' ', 'not-a-decimal', '1e999'])(
    'renders invalid telemetry input %s as unavailable',
    (value) => {
      expect(formatTelemetryUsd(value)).toBe('$—');
    },
  );

  it('rounds ordinary exact decimals without converting them through Number', () => {
    expect(formatTelemetryUsd('99999999999999999999999999.999999999999999999')).toBe(
      '$100,000,000,000,000,000,000,000,000.00',
    );
  });
});

describe('cost-source protection states', () => {
  const ready = {
    trackingStatus: 'tracked' as const,
    healthStatus: 'healthy' as const,
    hasPricing: true,
    authoritativeEnabled: true,
    controlReady: true,
    hasActiveHardStopBudget: true,
  };

  it('distinguishes all four public states without overclaiming protection', () => {
    expect(deriveCostSourceProtectionState(ready)).toBe('protected');
    expect(deriveCostSourceProtectionState({ ...ready, hasActiveHardStopBudget: false })).toBe(
      'ready_to_protect',
    );
    expect(deriveCostSourceProtectionState({ ...ready, controlReady: false })).toBe(
      'tracking_only',
    );
    expect(deriveCostSourceProtectionState({ ...ready, authoritativeEnabled: false })).toBe(
      'tracking_only',
    );
    expect(deriveCostSourceProtectionState({ ...ready, hasPricing: false })).toBe(
      'unpriced_uncontrolled',
    );
    expect(deriveCostSourceProtectionState({ ...ready, trackingStatus: 'pending' })).toBe(
      'unpriced_uncontrolled',
    );
    expect(deriveCostSourceProtectionState({ ...ready, healthStatus: 'broken' })).toBe(
      'unpriced_uncontrolled',
    );
  });
});
