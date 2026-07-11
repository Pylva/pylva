// Boundary tests for the simulator request validator.
//
// Pure module — real valibot schema, no mocks. Fake timers are used only
// where the schema itself calls `new Date()` (default period computation and
// the range check against "now").

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';
import { simulatorRequestSchema } from '../../src/lib/simulator/validator.js';

const NOW = '2026-07-09T12:00:00.000Z';

function swap(overrides: Record<string, unknown> = {}) {
  return {
    from_model: 'gpt-4o',
    to_model: 'gpt-4o-mini',
    from_provider: 'openai',
    to_provider: 'openai',
    ...overrides,
  };
}

function parse(input: unknown) {
  return v.safeParse(simulatorRequestSchema, input);
}

function expectPass(input: unknown) {
  const result = parse(input);
  if (!result.success) {
    throw new Error(`expected valid payload, got: ${result.issues[0].message}`);
  }
  return result.output;
}

function expectFail(input: unknown) {
  const result = parse(input);
  expect(result.success).toBe(false);
  if (result.success) throw new Error('expected parse failure');
  const issue = result.issues[0];
  return { message: issue.message, path: issue.path?.map((p) => p.key) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('simulatorRequestSchema — valid payloads', () => {
  it('accepts a fully-specified payload and normalizes dates to ISO timestamps', () => {
    const output = expectPass({
      customer_id: 'cust-1',
      period_start: '2026-01-01',
      period_end: '2026-01-31',
      model_swaps: [swap()],
    });

    expect(output).toEqual({
      customer_id: 'cust-1',
      period_start: '2026-01-01T00:00:00.000Z',
      period_end: '2026-01-31T00:00:00.000Z',
      model_swaps: [swap()],
    });
  });

  it('defaults customer_id to null and the period to the trailing 30 days', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const output = expectPass({ model_swaps: [swap()] });

    expect(output.customer_id).toBeNull();
    expect(output.period_end).toBe(NOW);
    expect(output.period_start).toBe('2026-06-09T12:00:00.000Z');
  });

  it('derives period_start as period_end minus 30 days when only period_end is given', () => {
    const output = expectPass({ period_end: '2026-03-31', model_swaps: [swap()] });

    expect(output.period_end).toBe('2026-03-31T00:00:00.000Z');
    expect(output.period_start).toBe('2026-03-01T00:00:00.000Z');
  });

  it('defaults period_end to now when only period_start is given', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));

    const output = expectPass({ period_start: '2026-02-01', model_swaps: [swap()] });

    expect(output.period_start).toBe('2026-02-01T00:00:00.000Z');
    expect(output.period_end).toBe(NOW);
  });

  it('accepts an explicit null customer_id', () => {
    const output = expectPass({ customer_id: null, model_swaps: [swap()] });
    expect(output.customer_id).toBeNull();
  });

  it('strips unknown top-level fields instead of rejecting them', () => {
    const output = expectPass({ model_swaps: [swap()], builder_id: 'sneaky', bogus: 1 });
    expect(output).not.toHaveProperty('builder_id');
    expect(output).not.toHaveProperty('bogus');
  });

  it('strips unknown fields inside a model swap', () => {
    const output = expectPass({ model_swaps: [swap({ price_override: 0 })] });
    expect(output.model_swaps[0]).toEqual(swap());
  });

  it('accepts exactly 10 model swaps (upper boundary)', () => {
    const output = expectPass({ model_swaps: Array.from({ length: 10 }, () => swap()) });
    expect(output.model_swaps).toHaveLength(10);
  });

  it('accepts a zero-length date range (start === end)', () => {
    const output = expectPass({
      period_start: '2026-02-01',
      period_end: '2026-02-01',
      model_swaps: [swap()],
    });
    expect(output.period_start).toBe(output.period_end);
  });

  it('accepts a range of exactly 180 days (upper boundary)', () => {
    expectPass({ period_start: '2026-01-01', period_end: '2026-06-30', model_swaps: [swap()] });
  });
});

describe('simulatorRequestSchema — model_swaps failures', () => {
  it('rejects a payload with no model_swaps key', () => {
    const issue = expectFail({});
    expect(issue.message).toBe('Invalid key: Expected "model_swaps" but received undefined');
    expect(issue.path).toEqual(['model_swaps']);
  });

  it('rejects a non-array model_swaps', () => {
    const issue = expectFail({ model_swaps: 'nope' });
    expect(issue.message).toBe('Invalid type: Expected Array but received "nope"');
    expect(issue.path).toEqual(['model_swaps']);
  });

  it('rejects an empty model_swaps array with the custom message', () => {
    const issue = expectFail({ model_swaps: [] });
    expect(issue.message).toBe('At least one model swap is required');
    expect(issue.path).toEqual(['model_swaps']);
  });

  it('rejects 11 model swaps with the cap message', () => {
    const issue = expectFail({ model_swaps: Array.from({ length: 11 }, () => swap()) });
    expect(issue.message).toBe('Maximum 10 model swaps per simulation');
    expect(issue.path).toEqual(['model_swaps']);
  });

  it.each(['from_model', 'to_model', 'from_provider', 'to_provider'] as const)(
    'rejects an empty-string %s',
    (field) => {
      const issue = expectFail({ model_swaps: [swap({ [field]: '' })] });
      expect(issue.message).toBe('Invalid length: Expected >=1 but received 0');
      expect(issue.path).toEqual(['model_swaps', 0, field]);
    },
  );

  it.each(['from_model', 'to_model', 'from_provider', 'to_provider'] as const)(
    'rejects a missing %s',
    (field) => {
      const issue = expectFail({ model_swaps: [swap({ [field]: undefined })] });
      expect(issue.message).toBe('Invalid type: Expected string but received undefined');
      expect(issue.path).toEqual(['model_swaps', 0, field]);
    },
  );

  it('rejects a non-string swap field', () => {
    const issue = expectFail({ model_swaps: [swap({ from_provider: 42 })] });
    expect(issue.message).toBe('Invalid type: Expected string but received 42');
    expect(issue.path).toEqual(['model_swaps', 0, 'from_provider']);
  });

  it('reports the failing swap index in the issue path', () => {
    const issue = expectFail({ model_swaps: [swap(), swap({ to_model: '' })] });
    expect(issue.path).toEqual(['model_swaps', 1, 'to_model']);
  });
});

describe('simulatorRequestSchema — customer_id failures', () => {
  it('rejects a non-string, non-null customer_id', () => {
    const issue = expectFail({ customer_id: 7, model_swaps: [swap()] });
    expect(issue.message).toBe('Invalid type: Expected string but received 7');
    expect(issue.path).toEqual(['customer_id']);
  });
});

describe('simulatorRequestSchema — period failures', () => {
  it('rejects a full ISO timestamp for period_start (date-only format required)', () => {
    const issue = expectFail({ period_start: '2026-01-15T00:00:00Z', model_swaps: [swap()] });
    expect(issue.message).toBe('Invalid date: Received "2026-01-15T00:00:00Z"');
    expect(issue.path).toEqual(['period_start']);
  });

  it('rejects an out-of-range calendar month in period_end', () => {
    const issue = expectFail({ period_end: '2026-13-01', model_swaps: [swap()] });
    expect(issue.message).toBe('Invalid date: Received "2026-13-01"');
    expect(issue.path).toEqual(['period_end']);
  });

  it('rejects a non-string period_start', () => {
    const issue = expectFail({ period_start: 42, model_swaps: [swap()] });
    expect(issue.message).toBe('Invalid type: Expected string but received 42');
    expect(issue.path).toEqual(['period_start']);
  });

  it('rejects a start date after the end date (negative range)', () => {
    const issue = expectFail({
      period_start: '2026-02-02',
      period_end: '2026-02-01',
      model_swaps: [swap()],
    });
    expect(issue.message).toBe('Date range must be between 0 and 180 days');
    expect(issue.path).toBeUndefined();
  });

  it('rejects a range of 181 days (one past the cap)', () => {
    const issue = expectFail({
      period_start: '2026-01-01',
      period_end: '2026-07-01',
      model_swaps: [swap()],
    });
    expect(issue.message).toBe('Date range must be between 0 and 180 days');
  });

  it('rejects a period_start more than 180 days before the defaulted "now" end', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW)); // 189.5 days after 2026-01-01

    const issue = expectFail({ period_start: '2026-01-01', model_swaps: [swap()] });
    expect(issue.message).toBe('Date range must be between 0 and 180 days');
  });
});
