import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPECTED_MIGRATIONS, EXPECTED_SCHEMA_HEAD } from '../../src/lib/db/migration-manifest.js';

const mocks = vi.hoisted(() => ({
  defaultUnsafe: vi.fn(),
}));

vi.mock('../../src/lib/db/client.js', () => ({
  sql: {
    unsafe: mocks.defaultUnsafe,
  },
}));

const { getSchemaStatus } = await import('../../src/lib/db/schema-status.js');

type SchemaStatusClient = NonNullable<Parameters<typeof getSchemaStatus>[0]>;

function stubClient(): { unsafe: ReturnType<typeof vi.fn> } {
  return { unsafe: vi.fn() };
}

function asSchemaStatusClient(client: { unsafe: ReturnType<typeof vi.fn> }): SchemaStatusClient {
  return client as unknown as SchemaStatusClient;
}

describe('getSchemaStatus', () => {
  beforeEach(() => {
    mocks.defaultUnsafe.mockReset();
  });

  it('reports in_sync when the full manifest is applied', async () => {
    const client = stubClient();
    client.unsafe.mockResolvedValueOnce(
      EXPECTED_MIGRATIONS.map((migration) => ({
        filename: migration.filename,
        checksum: migration.sha256,
      })),
    );

    const status = await getSchemaStatus(asSchemaStatusClient(client), 50);

    expect(client.unsafe).toHaveBeenCalledWith('SELECT filename, checksum FROM schema_migrations');
    expect(status).toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: EXPECTED_SCHEMA_HEAD,
      pending_count: 0,
      state: 'in_sync',
    });
  });

  it('reports behind with the exact pending count and applied head for partial ledgers', async () => {
    const appliedMigrations = EXPECTED_MIGRATIONS.slice(0, 3);
    const client = stubClient();
    client.unsafe.mockResolvedValueOnce(
      appliedMigrations.map((migration) => ({
        filename: migration.filename,
        checksum: migration.sha256,
      })),
    );

    const status = await getSchemaStatus(asSchemaStatusClient(client), 50);

    expect(status).toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: appliedMigrations.at(-1)?.filename,
      pending_count: EXPECTED_MIGRATIONS.length - appliedMigrations.length,
      state: 'behind',
    });
  });

  it('reports drift when an applied migration checksum differs from the manifest', async () => {
    const client = stubClient();
    client.unsafe.mockResolvedValueOnce(
      EXPECTED_MIGRATIONS.map((migration, index) => ({
        filename: migration.filename,
        checksum: index === 0 ? 'wrong-checksum' : migration.sha256,
      })),
    );

    const status = await getSchemaStatus(asSchemaStatusClient(client), 50);

    expect(status).toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: EXPECTED_SCHEMA_HEAD,
      pending_count: 0,
      state: 'drift',
    });
  });

  it('reports untracked when schema_migrations does not exist', async () => {
    const client = stubClient();
    client.unsafe.mockRejectedValueOnce(
      Object.assign(new Error('missing relation'), { code: '42P01' }),
    );

    const status = await getSchemaStatus(asSchemaStatusClient(client), 50);

    expect(status).toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: null,
      pending_count: null,
      state: 'untracked',
    });
  });

  it('reports unavailable for connection errors without rejecting', async () => {
    const client = stubClient();
    client.unsafe.mockRejectedValueOnce(new Error('connection refused'));

    await expect(getSchemaStatus(asSchemaStatusClient(client), 50)).resolves.toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: null,
      pending_count: null,
      state: 'unavailable',
    });
  });

  it('reports unavailable when the ledger query times out', async () => {
    const client = stubClient();
    client.unsafe.mockReturnValueOnce(new Promise(() => undefined));

    const status = await getSchemaStatus(asSchemaStatusClient(client), 1);

    expect(status).toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: null,
      pending_count: null,
      state: 'unavailable',
    });
  });

  it('stays in_sync when the ledger is ahead of the image manifest', async () => {
    const futureFilename = '999_future_migration.sql';
    const client = stubClient();
    client.unsafe.mockResolvedValueOnce([
      ...EXPECTED_MIGRATIONS.map((migration) => ({
        filename: migration.filename,
        checksum: migration.sha256,
      })),
      { filename: futureFilename, checksum: 'future-checksum' },
    ]);

    const status = await getSchemaStatus(asSchemaStatusClient(client), 50);

    expect(status).toEqual({
      expected_head: EXPECTED_SCHEMA_HEAD,
      applied_head: futureFilename,
      pending_count: 0,
      state: 'in_sync',
    });
  });
});
