import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';

import {
  commandWithClickHouseRetry,
  isMainModule,
  shouldSkipClickhouse,
  shouldSkipPostgres,
} from '../../db/setup.js';

describe('shouldSkipClickhouse', () => {
  it('skips when SKIP_CLICKHOUSE=true regardless of URL', () => {
    const result = shouldSkipClickhouse(
      { SKIP_CLICKHOUSE: 'true' },
      'http://clickhouse.example.com:8123',
    );
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('SKIP_CLICKHOUSE=true');
  });

  it('skips when CLICKHOUSE_URL host ends in .invalid (RFC 6761)', () => {
    const result = shouldSkipClickhouse({}, 'http://clickhouse-deferred.invalid:8123');
    expect(result.skip).toBe(true);
    expect(result.reason).toMatch(/clickhouse-deferred\.invalid.*RFC 6761/);
  });

  it('does not skip when URL is real and SKIP_CLICKHOUSE is unset', () => {
    const result = shouldSkipClickhouse({}, 'http://clickhouse.example.com:8123');
    expect(result.skip).toBe(false);
    expect(result.reason).toBeUndefined();
  });

  it('does not skip when SKIP_CLICKHOUSE has a non-true value', () => {
    const result = shouldSkipClickhouse(
      { SKIP_CLICKHOUSE: 'false' },
      'http://clickhouse.example.com:8123',
    );
    expect(result.skip).toBe(false);
  });

  it('falls through (no skip) on malformed URL so the client surfaces a clear error', () => {
    const result = shouldSkipClickhouse({}, 'not-a-url');
    expect(result.skip).toBe(false);
  });
});

describe('shouldSkipPostgres', () => {
  it('skips when SKIP_POSTGRES=true', () => {
    const result = shouldSkipPostgres({ SKIP_POSTGRES: 'true' });

    expect(result.skip).toBe(true);
    expect(result.reason).toBe('SKIP_POSTGRES=true');
  });

  it('does not skip when SKIP_POSTGRES is unset or non-true', () => {
    expect(shouldSkipPostgres({}).skip).toBe(false);
    expect(shouldSkipPostgres({ SKIP_POSTGRES: 'false' }).skip).toBe(false);
  });
});

describe('commandWithClickHouseRetry', () => {
  it('retries then succeeds on ClickHouse 517 with exponential backoff', async () => {
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(Object.assign(new Error('replica lag'), { code: '517' }))
      .mockRejectedValueOnce(
        Object.assign(new Error('replica lag'), { type: 'CANNOT_ASSIGN_ALTER' }),
      )
      .mockResolvedValueOnce(undefined);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const log = vi.fn((_line: string) => undefined);

    await commandWithClickHouseRetry(run, { attempts: 4, baseDelayMs: 10, log, sleep });

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
    expect(log).toHaveBeenNthCalledWith(1, 'retrying after CANNOT_ASSIGN_ALTER (attempt 2/4)');
    expect(log).toHaveBeenNthCalledWith(2, 'retrying after CANNOT_ASSIGN_ALTER (attempt 3/4)');
  });

  it('rethrows non-517 errors immediately with no retry', async () => {
    const error = Object.assign(new Error('syntax error'), { code: '62' });
    const run = vi.fn<() => Promise<unknown>>().mockRejectedValueOnce(error);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const log = vi.fn((_line: string) => undefined);

    await expect(commandWithClickHouseRetry(run, { log, sleep })).rejects.toBe(error);

    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('rethrows the last 517 when attempts are exhausted', async () => {
    const firstError = Object.assign(new Error('replica lag 1'), { code: '517' });
    const secondError = Object.assign(new Error('replica lag 2'), {
      type: 'CANNOT_ASSIGN_ALTER',
    });
    const lastError = Object.assign(new Error('replica lag 3'), { code: '517' });
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(firstError)
      .mockRejectedValueOnce(secondError)
      .mockRejectedValueOnce(lastError);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const log = vi.fn((_line: string) => undefined);

    await expect(
      commandWithClickHouseRetry(run, { attempts: 3, baseDelayMs: 5, log, sleep }),
    ).rejects.toBe(lastError);

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 5);
    expect(sleep).toHaveBeenNthCalledWith(2, 10);
    expect(log).toHaveBeenNthCalledWith(1, 'retrying after CANNOT_ASSIGN_ALTER (attempt 2/3)');
    expect(log).toHaveBeenNthCalledWith(2, 'retrying after CANNOT_ASSIGN_ALTER (attempt 3/3)');
  });
});

describe('PostgreSQL migration delegation', () => {
  it('delegates db/setup.ts migration application to db-migrate-core', async () => {
    const source = await fs.readFile(path.resolve('db/setup.ts'), 'utf8');

    expect(source).toMatch(
      /import\s+\{[\s\S]*applyPending[\s\S]*\}\s+from '\.\.\/scripts\/db-migrate-core\.js';/,
    );
    expect(source).not.toMatch(/\.begin\s*\(\s*\(?\s*s\s*\)?\s*=>\s*s\.unsafe\s*\(\s*content\s*\)/);
  });
});

describe('isMainModule', () => {
  it('matches script paths that contain spaces', () => {
    const argvPath = '/tmp/Pylva Launch Check/db/setup.ts';

    expect(isMainModule(pathToFileURL(argvPath).href, argvPath)).toBe(true);
  });

  it('does not match a different module url', () => {
    expect(
      isMainModule(
        pathToFileURL('/tmp/Pylva Launch Check/db/other.ts').href,
        '/tmp/Pylva Launch Check/db/setup.ts',
      ),
    ).toBe(false);
  });

  it('does not match when argv path is missing', () => {
    expect(isMainModule(pathToFileURL('/tmp/db/setup.ts').href, undefined)).toBe(false);
  });
});
