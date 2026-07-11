import { describe, it, expect } from 'vitest';
import { validateSemantic } from '../../src/lib/ingest/semantic-validation.js';
import type { TelemetryEvent } from '@pylva/shared';

const base: TelemetryEvent = {
  schema_version: '1.6',
  run_id: '11111111-1111-4111-8111-111111111111',
  parent_run_id: null,
  trace_id: '22222222-2222-4222-8222-222222222222',
  span_id: '33333333-3333-4333-8333-333333333333',
  parent_span_id: null,
  customer_id: 'cust_1',
  step_name: 'answer',
  model: 'gpt-4o',
  provider: 'openai',
  tokens_in: 10,
  tokens_out: 5,
  latency_ms: 100,
  tool_name: null,
  status: 'success',
  framework: 'none',
  instrumentation_tier: 'sdk_wrapper',
  cost_source: 'auto',
  metric: null,
  metric_value: null,
  stream_aborted: false,
  abort_savings_usd: 0,
  sdk_version: '0.0.1',
  timestamp: '2026-04-18T10:00:00.000Z',
};

describe('validateSemantic — sdk_wrapper tier', () => {
  it('accepts a well-formed LLM event', () => {
    expect(validateSemantic(base, new Date('2026-04-18T10:00:00Z'))).toEqual({
      ok: true,
    });
  });

  it('rejects when model is null', () => {
    const result = validateSemantic({ ...base, model: null }, new Date('2026-04-18T10:00:00Z'));
    expect(result).toEqual({
      ok: false,
      error: 'sdk_wrapper tier requires non-null model',
    });
  });

  it('rejects when provider is null', () => {
    const result = validateSemantic({ ...base, provider: null }, new Date('2026-04-18T10:00:00Z'));
    expect(result).toEqual({
      ok: false,
      error: 'sdk_wrapper tier requires non-null provider',
    });
  });

  it('rejects when metric or metric_value is set', () => {
    const result = validateSemantic(
      { ...base, metric: 'should_not_be_here', metric_value: 1 },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({
      ok: false,
      error: 'sdk_wrapper tier forbids metric / metric_value',
    });
  });
});

describe('validateSemantic — reported tier', () => {
  const reported: TelemetryEvent = {
    ...base,
    instrumentation_tier: 'reported',
    cost_source: 'configured',
    model: null,
    provider: null,
    tokens_in: 0,
    tokens_out: 0,
    metric: 'api_call',
    metric_value: 3,
  };

  it('accepts a well-formed reported event', () => {
    expect(validateSemantic(reported, new Date('2026-04-18T10:00:00Z'))).toEqual({ ok: true });
  });

  it('rejects when metric is null', () => {
    const result = validateSemantic(
      { ...reported, metric: null },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({
      ok: false,
      error: 'reported tier requires non-null metric',
    });
  });

  it('rejects when metric_value is negative', () => {
    const result = validateSemantic(
      { ...reported, metric_value: -1 },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({
      ok: false,
      error: 'reported tier requires metric_value ≥ 0',
    });
  });

  it('rejects when metric_value exceeds 1e9 cap (D20)', () => {
    const result = validateSemantic(
      { ...reported, metric_value: 1_000_000_001 },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('exceeds cap of 1000000000');
  });

  it('rejects when model is set', () => {
    const result = validateSemantic(
      { ...reported, model: 'gpt-4o' },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({ ok: false, error: 'reported tier forbids model' });
  });

  it('rejects when tokens_in or tokens_out non-zero', () => {
    const result = validateSemantic(
      { ...reported, tokens_in: 1 },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({
      ok: false,
      error: 'reported tier requires tokens_in = 0 and tokens_out = 0',
    });
  });
});

describe('validateSemantic — clock skew (D13)', () => {
  it('accepts timestamp NOW + 10min', () => {
    const now = new Date('2026-04-18T10:00:00Z');
    const tenMinFuture = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
    expect(validateSemantic({ ...base, timestamp: tenMinFuture }, now)).toEqual({ ok: true });
  });

  it('rejects timestamp NOW + 20min', () => {
    const now = new Date('2026-04-18T10:00:00Z');
    const twentyMinFuture = new Date(now.getTime() + 20 * 60 * 1000).toISOString();
    const result = validateSemantic({ ...base, timestamp: twentyMinFuture }, now);
    expect(result).toEqual({
      ok: false,
      error: 'timestamp exceeds NOW() + 15 minutes',
    });
  });
});

describe('validateSemantic — aborted status / stream_aborted coupling', () => {
  it('accepts aborted status with stream_aborted=true', () => {
    const result = validateSemantic(
      {
        ...base,
        status: 'aborted',
        stream_aborted: true,
        abort_savings_usd: 0.01,
      },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({ ok: true });
  });

  it('rejects aborted status without stream_aborted', () => {
    const result = validateSemantic(
      { ...base, status: 'aborted', stream_aborted: false },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result.ok).toBe(false);
  });

  it('rejects stream_aborted=true without aborted status', () => {
    const result = validateSemantic(
      { ...base, status: 'success', stream_aborted: true },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result.ok).toBe(false);
  });
});

describe('validateSemantic — abort_savings_usd Decimal(10,6) overflow guard', () => {
  it('rejects abort_savings_usd above the storable maximum', () => {
    const result = validateSemantic(
      {
        ...base,
        status: 'aborted',
        stream_aborted: true,
        abort_savings_usd: 10_000,
      },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be between 0');
  });

  it('accepts abort_savings_usd exactly at the storable maximum', () => {
    const result = validateSemantic(
      {
        ...base,
        status: 'aborted',
        stream_aborted: true,
        abort_savings_usd: 9999.999999,
      },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({ ok: true });
  });

  it.each([
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s abort_savings_usd', (_label, abort_savings_usd) => {
    const result = validateSemantic(
      {
        ...base,
        status: 'aborted',
        stream_aborted: true,
        abort_savings_usd,
      },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('must be between 0');
  });
});

describe('validateSemantic — customer_id composite-key injection guard', () => {
  it('rejects customer_id with colon (reserved for composite key)', () => {
    const result = validateSemantic(
      { ...base, customer_id: 'foo:bar' },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('forbidden character');
  });
});

describe('validateSemantic — UInt32 token bounds', () => {
  it.each([
    ['negative tokens_in', { tokens_in: -1 }],
    ['negative tokens_out', { tokens_out: -1 }],
    ['fractional tokens_in', { tokens_in: 1.5 }],
    ['NaN tokens_in', { tokens_in: Number.NaN }],
    ['infinite tokens_out', { tokens_out: Number.POSITIVE_INFINITY }],
    ['tokens_in above UInt32 max', { tokens_in: 4_294_967_296 }],
  ])('rejects token counts that do not fit UInt32 columns: %s', (_caseName, patch) => {
    const result = validateSemantic({ ...base, ...patch }, new Date('2026-04-18T10:00:00Z'));
    expect(result).toEqual({
      ok: false,
      error: 'tokens_in/tokens_out must fit UInt32 (0-4294967295)',
    });
  });

  it('accepts the maximum UInt32 token count boundary', () => {
    const result = validateSemantic(
      { ...base, tokens_in: 4_294_967_295, tokens_out: 4_294_967_295 },
      new Date('2026-04-18T10:00:00Z'),
    );
    expect(result).toEqual({ ok: true });
  });
});
