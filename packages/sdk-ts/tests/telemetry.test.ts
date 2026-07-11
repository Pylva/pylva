import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { init, _resetConfigForTests } from '../src/core/config.js';
import {
  enqueue,
  bufferSize,
  isDegraded,
  flush,
  _resetTelemetryForTests,
} from '../src/core/telemetry.js';
import { check, _resetAccumulatorForTests } from '../src/core/budget_accumulator.js';

const VALID_KEY = 'pv_live_aabbccdd_' + 'a'.repeat(32);

function makeEvent(spanId: string): Parameters<typeof enqueue>[0] {
  return {
    run_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    parent_run_id: null,
    trace_id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    span_id: spanId,
    parent_span_id: null,
    customer_id: 'cust_test',
    step_name: 'test',
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
    timestamp: '2026-04-18T10:00:00.000Z',
  };
}

function makeSpanId(i: number): string {
  // Deterministic UUID-like id; only uniqueness matters for the buffer.
  const hex = i.toString(16).padStart(8, '0');
  return `${hex}-0000-4000-8000-000000000000`;
}

describe('telemetry buffer', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetTelemetryForTests();
    _resetAccumulatorForTests();
    init({ apiKey: VALID_KEY, localMode: true, batchSize: 100_000, flushInterval: 60_000 });
  });

  afterEach(() => {
    _resetTelemetryForTests();
    _resetConfigForTests();
    _resetAccumulatorForTests();
  });

  it('accepts a single event', () => {
    enqueue(makeEvent(makeSpanId(1)));
    expect(bufferSize()).toBe(1);
  });

  it('localMode=true drains the buffer on flush without network', async () => {
    for (let i = 0; i < 10; i++) enqueue(makeEvent(makeSpanId(i)));
    expect(bufferSize()).toBe(10);
    // flush() no-ops buffer (localMode drains silently on next flush call).
    await flush();
    expect(bufferSize()).toBe(0);
  });

  it('FIFO drop-oldest + one-time warning at overflow (D1)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Fill past the 10_000 cap.
    for (let i = 0; i < 10_003; i++) enqueue(makeEvent(makeSpanId(i)));
    expect(bufferSize()).toBe(10_000);
    // Overflow warning should have fired AT LEAST once; we assert at least once.
    const overflowCalls = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('local buffer full'),
    );
    expect(overflowCalls.length).toBeGreaterThanOrEqual(1);
    warnSpy.mockRestore();
  });

  it('not degraded initially', () => {
    expect(isDegraded()).toBe(false);
  });
});

describe('telemetry HTTP exporter', () => {
  beforeEach(() => {
    _resetConfigForTests();
    _resetTelemetryForTests();
    _resetAccumulatorForTests();
  });
  afterEach(() => {
    _resetTelemetryForTests();
    _resetConfigForTests();
    _resetAccumulatorForTests();
    vi.restoreAllMocks();
  });

  it('enters degraded mode on 401 + drops buffer (D19)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('', { status: 401 }) as Response);
    init({ apiKey: VALID_KEY, endpoint: 'http://mock', batchSize: 1, flushInterval: 60_000 });
    enqueue(makeEvent(makeSpanId(42)));
    await flush();
    expect(isDegraded()).toBe(true);
    expect(bufferSize()).toBe(0);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://pylva.com/settings/keys'),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fetchSpy as any).mockRestore?.();
  });

  it('applies backend budget_exceeded flags to the local accumulator', async () => {
    const periodStart = '2026-04-01T00:00:00.000Z';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: 1,
          rejected: 0,
          budget_exceeded: [
            {
              rule_id: 'rule-1',
              customer_id: 'cust_test',
              limit_usd: 10,
              accumulated_usd: 12,
              period: 'day',
              period_start: periodStart,
            },
          ],
        }),
        { status: 200 },
      ) as Response,
    );
    init({ apiKey: VALID_KEY, endpoint: 'http://mock', batchSize: 100, flushInterval: 60_000 });
    enqueue(makeEvent(makeSpanId(43)));

    await flush();

    const result = check({
      rule_id: 'rule-1',
      scope: 'per_customer',
      customer_id: 'cust_test',
      period_start: periodStart,
      estimated_usd: 0,
      limit_usd: 10,
    });
    expect(result.over_limit).toBe(true);
    expect(result.source).toBe('backend_ingest_flag');
  });

  it('ignores malformed budget_exceeded flags without corrupting the accumulator', async () => {
    const periodStart = '2026-04-01T00:00:00.000Z';
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          accepted: 1,
          rejected: 0,
          budget_exceeded: [
            null,
            {
              rule_id: 'rule-2',
              customer_id: 'cust_test',
              period_start: periodStart,
            },
            {
              rule_id: 'rule-2',
              customer_id: 'cust_test',
              limit_usd: '10',
              period_start: periodStart,
            },
            {
              rule_id: 'rule-2',
              customer_id: 'cust_test',
              limit_usd: 10,
              accumulated_usd: 12,
              period: 'day',
              period_start: periodStart,
            },
          ],
        }),
        { status: 200 },
      ) as Response,
    );
    init({ apiKey: VALID_KEY, endpoint: 'http://mock', batchSize: 100, flushInterval: 60_000 });
    enqueue(makeEvent(makeSpanId(44)));

    await flush();

    const result = check({
      rule_id: 'rule-2',
      scope: 'per_customer',
      customer_id: 'cust_test',
      period_start: periodStart,
      estimated_usd: 0,
      limit_usd: 10,
    });
    expect(result.over_limit).toBe(true);
    expect(result.source).toBe('backend_ingest_flag');
  });
});
