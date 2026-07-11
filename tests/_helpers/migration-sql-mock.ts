import type { MigrateSqlClient, MigrateTx } from '../../scripts/db-migrate-core.js';

export interface RecordedCall {
  kind: 'client.unsafe' | 'begin.enter' | 'tx.unsafe' | 'begin.exit';
  query?: string;
  params?: unknown[];
}

export function createRecordingSqlClient(opts?: {
  ledgerRows?: Array<{ filename: string; checksum: string }>;
  regclasses?: Partial<Record<'schema_migrations' | 'builders', boolean>>;
  failOn?: (query: string) => Error | undefined;
}): { client: MigrateSqlClient; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const ledgerRows = opts?.ledgerRows ?? [];
  const regclasses = {
    schema_migrations: opts?.regclasses?.schema_migrations ?? opts?.ledgerRows !== undefined,
    builders: opts?.regclasses?.builders ?? true,
  };

  function maybeFail(query: string): void {
    const error = opts?.failOn?.(query);
    if (error) {
      throw error;
    }
  }

  function regclassRows(
    name: 'schema_migrations' | 'builders',
  ): Array<{ regclass: string | null }> {
    return [{ regclass: regclasses[name] ? name : null }];
  }

  async function unsafe(
    query: string,
    params?: unknown[],
  ): Promise<Array<Record<string, unknown>>> {
    calls.push({ kind: 'client.unsafe', query, params });
    maybeFail(query);

    if (query.includes("to_regclass('public.schema_migrations')")) {
      return regclassRows('schema_migrations');
    }
    if (query.includes("to_regclass('public.builders')")) {
      return regclassRows('builders');
    }
    if (query.includes('FROM schema_migrations')) {
      return ledgerRows;
    }
    return [];
  }

  const client: MigrateSqlClient = {
    unsafe,
    begin: async <T>(fn: (tx: MigrateTx) => Promise<T>): Promise<T> => {
      calls.push({ kind: 'begin.enter' });
      try {
        return await fn({
          unsafe: async (query: string, params?: unknown[]): Promise<unknown> => {
            calls.push({ kind: 'tx.unsafe', query, params });
            maybeFail(query);
            return undefined;
          },
        });
      } finally {
        calls.push({ kind: 'begin.exit' });
      }
    },
    end: async (): Promise<void> => undefined,
  };

  return { client, calls };
}
