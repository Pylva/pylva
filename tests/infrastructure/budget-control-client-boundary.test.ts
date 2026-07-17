import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const candidate = path.join(directory, entry);
    return statSync(candidate).isDirectory()
      ? sourceFiles(candidate)
      : /\.(?:ts|tsx)$/.test(candidate)
        ? [candidate]
        : [];
  });
}

describe('authoritative database client source boundary', () => {
  it('keeps the raw dedicated pool private to client construction and posture attestation', () => {
    const importers = sourceFiles('src')
      .filter((file) => readFileSync(file, 'utf8').includes('getBudgetControlSql'))
      .map((file) => path.relative('.', file))
      .sort();

    expect(importers).toEqual([
      'src/lib/budget-control/client.ts',
      'src/lib/budget-control/runtime-posture.ts',
    ]);
  });

  it('keeps the raw authoritative ClickHouse projector client private to construction and posture', () => {
    const importers = sourceFiles('src')
      .filter((file) => readFileSync(file, 'utf8').includes('getBudgetProjectionClickHouseClient'))
      .map((file) => path.relative('.', file))
      .sort();

    expect(importers).toEqual([
      'src/lib/budget-projection/clickhouse-client.ts',
      'src/lib/budget-projection/clickhouse-posture.ts',
    ]);
  });

  it('routes the sole authoritative insert implementation through the ready dedicated client', () => {
    const target = readFileSync('src/lib/budget-projection/clickhouse.ts', 'utf8');
    expect(target).toContain("import('./clickhouse-posture.js')");
    expect(target).toContain('getReadyBudgetProjectionClickHouseClient()');
    expect(target).not.toContain("import('../clickhouse/client.js')");

    const directInsertImplementations = sourceFiles('src')
      .filter((file) =>
        /table:\s*AUTHORITATIVE_BUDGET_COST_EVENT_TABLE/u.test(readFileSync(file, 'utf8')),
      )
      .map((file) => path.relative('.', file));
    expect(directInsertImplementations).toEqual(['src/lib/budget-projection/clickhouse.ts']);
  });

  it('does not let authoritative transaction, projection, or expiry use the general app pool', () => {
    for (const file of [
      'src/lib/budget-control/transaction.ts',
      'src/lib/budget-control/expiry-runner.ts',
      'src/lib/budget-projection/postgres.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(/(?:\.\.\/)+db\/client/);
    }
  });

  it('routes dashboard authority reads through the dedicated budget-control transaction', () => {
    const source = readFileSync('src/lib/budget-activity/read-model.ts', 'utf8');

    expect(source).toContain("from '../budget-control/read-transaction.js'");
    expect(source).toContain('withBudgetControlReadTransaction(builderId');
    expect(source).not.toContain("from '../db/rls.js'");
    expect(source).not.toContain('withRLS(');
  });
});
