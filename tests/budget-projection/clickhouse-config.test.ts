import { describe, expect, it } from 'vitest';
import {
  BudgetProjectionClickHouseConfigError,
  parseClickHousePrincipal,
  resolveBudgetProjectionClickHouseConfig,
} from '../../src/lib/budget-projection/clickhouse-config.js';

const GENERAL = 'https://app_reader:general-secret@clickhouse.internal:8443/pylva';
const PROJECTOR = 'https://budget_projector:projector-secret@clickhouse.internal:8443/pylva';

function production(overrides: Record<string, string | undefined> = {}) {
  return {
    NODE_ENV: 'production',
    CLICKHOUSE_URL: GENERAL,
    BUDGET_PROJECTION_CLICKHOUSE_URL: PROJECTOR,
    ...overrides,
  };
}

describe('authoritative projection ClickHouse credential resolution', () => {
  it('accepts a password-bearing distinct production principal on the same target', () => {
    expect(resolveBudgetProjectionClickHouseConfig(production())).toEqual({
      connectionUrl: PROJECTOR,
      database: 'pylva',
      expectedGeneralUsername: 'app_reader',
      expectedProjectorUsername: 'budget_projector',
      source: 'dedicated',
    });
  });

  it.each([
    ['missing dedicated URL', { BUDGET_PROJECTION_CLICKHOUSE_URL: undefined }, 'missing_url'],
    [
      'production fallback flag',
      { ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK: 'true' },
      'fallback_forbidden',
    ],
    [
      'reused username',
      {
        BUDGET_PROJECTION_CLICKHOUSE_URL:
          'https://app_reader:different@clickhouse.internal:8443/pylva',
      },
      'credential_reuse',
    ],
    [
      'default username',
      {
        BUDGET_PROJECTION_CLICKHOUSE_URL: 'https://clickhouse.internal:8443/pylva',
      },
      'invalid_url',
    ],
    [
      'missing credential',
      {
        BUDGET_PROJECTION_CLICKHOUSE_URL: 'https://budget_projector@clickhouse.internal:8443/pylva',
      },
      'invalid_url',
    ],
    [
      'different host',
      {
        BUDGET_PROJECTION_CLICKHOUSE_URL:
          'https://budget_projector:secret@other.internal:8443/pylva',
      },
      'target_mismatch',
    ],
    [
      'different database',
      {
        BUDGET_PROJECTION_CLICKHOUSE_URL:
          'https://budget_projector:secret@clickhouse.internal:8443/other',
      },
      'target_mismatch',
    ],
    [
      'plaintext production credentials',
      {
        CLICKHOUSE_URL: 'http://app_reader:general@clickhouse.internal:8123/pylva',
        BUDGET_PROJECTION_CLICKHOUSE_URL:
          'http://budget_projector:secret@clickhouse.internal:8123/pylva',
      },
      'insecure_transport',
    ],
    [
      'general principal without a credential',
      { CLICKHOUSE_URL: 'https://app_reader@clickhouse.internal:8443/pylva' },
      'invalid_url',
    ],
  ] as const)('fails closed for %s', (_label, overrides, code) => {
    expect(() => resolveBudgetProjectionClickHouseConfig(production(overrides))).toThrow(
      expect.objectContaining<Partial<BudgetProjectionClickHouseConfigError>>({ code }),
    );
  });

  it('permits general-principal reuse only through the explicit local/CI fallback', () => {
    expect(
      resolveBudgetProjectionClickHouseConfig({
        NODE_ENV: 'test',
        CLICKHOUSE_URL: 'http://localhost:8123/test_db',
        ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK: 'true',
      }),
    ).toEqual({
      connectionUrl: 'http://localhost:8123/test_db',
      database: 'test_db',
      expectedGeneralUsername: 'default',
      expectedProjectorUsername: 'default',
      source: 'local_ci_fallback',
    });
  });

  it('rejects an implicit or disguised local reuse when the fallback flag is absent', () => {
    expect(() =>
      resolveBudgetProjectionClickHouseConfig({
        NODE_ENV: 'test',
        CLICKHOUSE_URL: GENERAL,
      }),
    ).toThrow(expect.objectContaining({ code: 'missing_url' }));
    expect(() =>
      resolveBudgetProjectionClickHouseConfig({
        NODE_ENV: 'development',
        CLICKHOUSE_URL: GENERAL,
        BUDGET_PROJECTION_CLICKHOUSE_URL: 'http://app_reader:other@clickhouse.internal:8123/other',
      }),
    ).toThrow(expect.objectContaining({ code: 'credential_reuse' }));
  });

  it('allows a distinct explicit development principal without enabling fallback', () => {
    expect(
      resolveBudgetProjectionClickHouseConfig({
        NODE_ENV: 'development',
        CLICKHOUSE_URL: GENERAL,
        BUDGET_PROJECTION_CLICKHOUSE_URL: PROJECTOR,
      }).source,
    ).toBe('dedicated');
  });

  it('decodes principal and database identity without returning the password', () => {
    expect(
      parseClickHousePrincipal(
        'https://budget%5Fprojector:do-not-return@clickhouse.internal/pylva%5Fprod',
      ),
    ).toEqual({
      database: 'pylva_prod',
      hostname: 'clickhouse.internal',
      origin: 'https://clickhouse.internal',
      passwordPresent: true,
      protocol: 'https:',
      username: 'budget_projector',
    });
  });

  it('allows insecure transport only for an explicit loopback integration harness', () => {
    expect(
      resolveBudgetProjectionClickHouseConfig(
        {
          NODE_ENV: 'production',
          CLICKHOUSE_URL: 'http://app_reader:general@127.0.0.1:8123/pylva',
          BUDGET_PROJECTION_CLICKHOUSE_URL:
            'http://budget_projector:projector@127.0.0.1:8123/pylva',
        },
        { allowInsecureLoopbackForTests: true },
      ).source,
    ).toBe('dedicated');
    expect(() =>
      resolveBudgetProjectionClickHouseConfig(
        {
          NODE_ENV: 'production',
          CLICKHOUSE_URL: 'http://app_reader:general@clickhouse.internal:8123/pylva',
          BUDGET_PROJECTION_CLICKHOUSE_URL:
            'http://budget_projector:projector@clickhouse.internal:8123/pylva',
        },
        { allowInsecureLoopbackForTests: true },
      ),
    ).toThrow(expect.objectContaining({ code: 'insecure_transport' }));
  });

  it('never includes supplied URL secrets in a configuration error', () => {
    const secret = 'super-secret-value';
    let thrown: unknown;
    try {
      resolveBudgetProjectionClickHouseConfig(
        production({
          BUDGET_PROJECTION_CLICKHOUSE_URL: `ftp://budget_projector:${secret}@clickhouse.internal/pylva`,
        }),
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BudgetProjectionClickHouseConfigError);
    expect(String(thrown)).not.toContain(secret);
  });
});
