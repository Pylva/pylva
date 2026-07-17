import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index.js';

describe('authoritative-control public surface', () => {
  it('exports the v1.2 functions, config constants, errors, and explicit-client methods', () => {
    expect(sdk.SDK_VERSION).toBe('1.2.0');
    for (const name of [
      'ready',
      'controlStatus',
      'reserveUsage',
      'commitUsage',
      'releaseUsage',
      'extendUsage',
    ] as const) {
      expect(typeof sdk[name]).toBe('function');
      expect(typeof sdk.Pylva.prototype[name]).toBe('function');
    }
    expect(sdk.ControlMode).toEqual({ LEGACY: 'legacy', SHADOW: 'shadow', ENFORCE: 'enforce' });
    expect(sdk.ControlUnavailablePolicy).toEqual({ ALLOW: 'allow', DENY: 'deny' });
    expect(typeof sdk.PylvaControlUnavailableError).toBe('function');
    expect(typeof sdk.PylvaControlApiError).toBe('function');
    expect(typeof sdk.PylvaControlValidationError).toBe('function');
    expect(typeof sdk.shouldSuppressLegacyTelemetry).toBe('function');
    expect(sdk.BudgetExceededSource.AUTHORITATIVE_CONTROL).toBe('authoritative_control');
  });

  it('keeps the legacy PylvaBudgetExceeded constructor and fields source-compatible', () => {
    const error = new sdk.PylvaBudgetExceeded({
      source: sdk.BudgetExceededSource.SDK_PRECALL,
      rule_id: 'legacy-rule',
      customer_id: null,
      period: 'day',
      period_start: '2026-07-14T00:00:00.000Z',
      limit_usd: 10,
      accumulated_usd: 9,
      estimated_usd: 1,
    });
    expect(error).toBeInstanceOf(sdk.PylvaBudgetExceeded);
    expect(error.code).toBe('budget_exceeded');
    expect(error.rule_id).toBe('legacy-rule');
    expect(error.authoritativeDenial).toBeUndefined();
  });
});
