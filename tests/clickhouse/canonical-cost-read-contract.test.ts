import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function runtimeSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return runtimeSources(absolute);
      return /\.[cm]?[jt]sx?$/.test(entry.name) ? [absolute] : [];
    }),
  );
  return nested.flat();
}

describe('canonical mixed cost-event read contract', () => {
  it('has no runtime SQL read that bypasses the authoritative-compatible view', async () => {
    const violations: string[] = [];
    for (const file of await runtimeSources(path.resolve('src'))) {
      const source = await readFile(file, 'utf8');
      const directRead =
        /\b(?:FROM|JOIN)\s+(?:(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\.)?(?:`cost_events`|"cost_events"|cost_events)(?![A-Za-z0-9_])/gi;
      for (const match of source.matchAll(directRead)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(process.cwd(), file)}:${line}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it.each([
    'src/lib/clickhouse/dashboard-queries.ts',
    'src/app/api/v1/export/csv/route.ts',
    'src/lib/anomaly/clickhouse-queries.ts',
    'src/lib/portal/data.ts',
    'src/lib/budget/aggregate.ts',
    'src/lib/rules/preview.ts',
    'src/lib/health/runner.ts',
    'src/lib/ingest/event-cap.ts',
    'src/lib/pricing/backfill.ts',
    'src/lib/pricing/reconcile.ts',
  ])('%s reads the canonical mixed view', async (file) => {
    const source = await readFile(file, 'utf8');
    expect(source).toContain('cost_events_with_control');
  });

  it('keeps telemetry ingestion physical and outside the read contract', async () => {
    const source = await readFile('src/lib/clickhouse/client.ts', 'utf8');
    expect(source).toContain("table: 'cost_events'");
    expect(source).not.toMatch(
      /\b(?:FROM|JOIN)\s+(?:(?:`[^`]+`|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\.)?(?:`cost_events`|"cost_events"|cost_events)(?![A-Za-z0-9_])/i,
    );
  });

  it('keeps authoritative commit and projection outside the legacy ingest event cap', async () => {
    const roots = ['src/lib/budget-control', 'src/lib/budget-projection'];
    const references: string[] = [];
    for (const root of roots) {
      for (const file of await runtimeSources(path.resolve(root))) {
        const source = await readFile(file, 'utf8');
        if (/checkEventCap|recordAcceptedEvents|ingest\/event-cap/.test(source)) {
          references.push(path.relative(process.cwd(), file));
        }
      }
    }
    expect(references).toEqual([]);
  });

  it('parses every dashboard date boundary as UTC independently of the ClickHouse server timezone', async () => {
    const source = await readFile('src/lib/clickhouse/dashboard-queries.ts', 'utf8');
    const fromBoundaries = source.match(
      /timestamp >= parseDateTime64BestEffort\(\{from:String\}, 3, 'UTC'\)/g,
    );
    const toBoundaries = source.match(
      /timestamp <= parseDateTime64BestEffort\(\{to:String\}, 3, 'UTC'\)/g,
    );

    expect(fromBoundaries).toHaveLength(6);
    expect(toBoundaries).toHaveLength(6);
    expect(source).not.toMatch(/\{(?:from|to):DateTime\}/);
  });

  it('does not let any runtime ClickHouse timestamp parameter inherit the server timezone', async () => {
    const violations: string[] = [];
    for (const file of await runtimeSources(path.resolve('src'))) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/\{[A-Za-z_][A-Za-z0-9_]*:DateTime\}/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(process.cwd(), file)}:${line}`);
      }
    }

    expect(violations).toEqual([]);
  });

  it('does not let best-effort timestamp parsing inherit the server timezone', async () => {
    const violations: string[] = [];
    for (const file of await runtimeSources(path.resolve('src'))) {
      const source = await readFile(file, 'utf8');
      for (const match of source.matchAll(/parseDateTimeBestEffort\(\{[^}]+:String\}\)/g)) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${path.relative(process.cwd(), file)}:${line}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
