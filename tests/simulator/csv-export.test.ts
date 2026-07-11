// Pins the exact CSV wire format of src/lib/simulator/csv-export.ts.
//
// Pure module — real imports, no mocks. Dashboards and spreadsheets consume
// this output, so the assertions are full-string equality.

import { describe, expect, it } from 'vitest';
import type { SimulatorBreakdown, SimulatorResult } from '@pylva/shared';
import { simulatorResultToCsv } from '../../src/lib/simulator/csv-export.js';

const HEADER =
  'customer_id,provider,step_name,original_model,simulated_model,' +
  'original_cost_usd,simulated_cost_usd,savings_usd,event_count';

function row(overrides: Partial<SimulatorBreakdown> = {}): SimulatorBreakdown {
  return {
    customer_id: 'cust-1',
    provider: 'openai',
    step_name: 'chat',
    original_model: 'gpt-4o',
    simulated_model: 'gpt-4o-mini',
    original_cost_usd: 1.5,
    simulated_cost_usd: 0.25,
    event_count: 42,
    ...overrides,
  };
}

function result(
  breakdown: SimulatorBreakdown[],
  overrides: Partial<SimulatorResult> = {},
): SimulatorResult {
  return {
    original_cost_usd: breakdown.reduce((s, b) => s + b.original_cost_usd, 0),
    simulated_cost_usd: breakdown.reduce((s, b) => s + b.simulated_cost_usd, 0),
    savings_usd:
      breakdown.reduce((s, b) => s + b.original_cost_usd, 0) -
      breakdown.reduce((s, b) => s + b.simulated_cost_usd, 0),
    savings_percent: 0,
    breakdown,
    period_start: '2026-01-01T00:00:00.000Z',
    period_end: '2026-01-31T00:00:00.000Z',
    freshness_timestamp: null,
    warnings: [],
    ...overrides,
  };
}

describe('simulatorResultToCsv', () => {
  it('emits header, one line per breakdown row, and a TOTAL summary — exact output', () => {
    const csv = simulatorResultToCsv(
      result([
        row(),
        row({
          customer_id: 'cust-2',
          provider: 'anthropic',
          step_name: null, // null renders as "unattributed"
          original_model: 'claude-3-opus',
          simulated_model: 'claude-3-haiku',
          original_cost_usd: 10,
          simulated_cost_usd: 2.5,
          event_count: 7,
        }),
      ]),
    );

    expect(csv).toBe(
      [
        HEADER,
        'cust-1,openai,chat,gpt-4o,gpt-4o-mini,1.500000,0.250000,1.250000,42',
        'cust-2,anthropic,unattributed,claude-3-opus,claude-3-haiku,10.000000,2.500000,7.500000,7',
        'TOTAL,,,,,11.500000,2.750000,8.750000,',
      ].join('\n'),
    );
  });

  it('emits only header and an all-zero TOTAL row for an empty breakdown', () => {
    const csv = simulatorResultToCsv(result([]));
    expect(csv).toBe(`${HEADER}\nTOTAL,,,,,0.000000,0.000000,0.000000,`);
  });

  it('does not end with a trailing newline', () => {
    const csv = simulatorResultToCsv(result([row()]));
    expect(csv.endsWith('\n')).toBe(false);
  });

  it('escapes commas, quotes, and newlines, and neutralizes formula prefixes', () => {
    const csv = simulatorResultToCsv(
      result([
        row({
          customer_id: 'acme, inc', // comma → quoted
          provider: 'quote"y', // quote → quoted + doubled
          step_name: 'line1\nline2', // newline → quoted, newline preserved
          original_model: '=SUM(A1)', // formula prefix → leading apostrophe
          simulated_model: '-flagged', // dash prefix → leading apostrophe
          original_cost_usd: 1,
          simulated_cost_usd: 1,
          event_count: 1,
        }),
        row({
          customer_id: '+alert,now', // prefix + comma → apostrophe, then quoted
          provider: '@handle',
          step_name: 'ok',
          original_model: 'm',
          simulated_model: 'm',
          original_cost_usd: 0,
          simulated_cost_usd: 0,
          event_count: 0,
        }),
      ]),
    );

    const [, ...body] = csv.split('\n');
    expect(body.slice(0, 2).join('\n')).toBe(
      '"acme, inc","quote""y","line1\nline2",\'=SUM(A1),\'-flagged,1.000000,1.000000,0.000000,1',
    );
    expect(body[2]).toBe('"\'+alert,now",\'@handle,ok,m,m,0.000000,0.000000,0.000000,0');
  });

  it('formats costs to six decimals, keeps event_count unpadded, and allows negative savings', () => {
    const csv = simulatorResultToCsv(
      result([
        row({
          customer_id: 'c',
          provider: 'p',
          step_name: '', // empty string is NOT null → stays empty, not "unattributed"
          original_model: 'a',
          simulated_model: 'b',
          original_cost_usd: 3,
          simulated_cost_usd: 4.5, // more expensive → negative savings
          event_count: 1000000,
        }),
        row({
          customer_id: 'd',
          provider: 'p',
          step_name: 's',
          original_model: 'a',
          simulated_model: 'b',
          original_cost_usd: 0.123456789, // rounded to 6dp
          simulated_cost_usd: 0,
          event_count: 0,
        }),
      ]),
    );

    const lines = csv.split('\n');
    expect(lines[1]).toBe('c,p,,a,b,3.000000,4.500000,-1.500000,1000000');
    expect(lines[2]).toBe('d,p,s,a,b,0.123457,0.000000,0.123457,0');
  });

  it('preserves breakdown order (no re-sorting by cost)', () => {
    const csv = simulatorResultToCsv(
      result([
        row({ customer_id: 'small', original_cost_usd: 1, simulated_cost_usd: 1 }),
        row({ customer_id: 'huge', original_cost_usd: 100, simulated_cost_usd: 100 }),
        row({ customer_id: 'mid', original_cost_usd: 10, simulated_cost_usd: 10 }),
      ]),
    );

    const order = csv
      .split('\n')
      .slice(1, 4)
      .map((line) => line.split(',')[0]);
    expect(order).toEqual(['small', 'huge', 'mid']);
  });

  it('takes TOTAL from the result fields, not recomputed from rows', () => {
    const csv = simulatorResultToCsv(
      result([row({ original_cost_usd: 1, simulated_cost_usd: 1 })], {
        original_cost_usd: 999,
        simulated_cost_usd: 111,
        savings_usd: 888,
      }),
    );

    const lines = csv.split('\n');
    expect(lines[lines.length - 1]).toBe('TOTAL,,,,,999.000000,111.000000,888.000000,');
  });
});
