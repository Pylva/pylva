import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('trace control-event projection contract', () => {
  it('reads the deduplicated legacy-plus-authoritative view for span decoration', async () => {
    const source = await readFile('src/lib/clickhouse/dashboard-queries.ts', 'utf8');
    const traceSection = source.slice(
      source.indexOf('export async function getTraceTree'),
      source.indexOf('export interface RecentTraceRow'),
    );
    expect(traceSection.match(/FROM cost_events_with_control/g)).toHaveLength(2);
    expect(traceSection).not.toMatch(/FROM cost_events(?:\s|`)/);
  });
});
