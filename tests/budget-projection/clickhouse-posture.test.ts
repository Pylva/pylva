import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClickHouseClient } from '@clickhouse/client';

const mocks = vi.hoisted(() => ({
  env: {
    NODE_ENV: 'production',
    ENABLE_AUTHORITATIVE_BUDGET_CONTROL: true,
  },
  generalClient: {} as ClickHouseClient,
  projectorClient: {} as ClickHouseClient,
  getClient: vi.fn(),
  getMetadata: vi.fn(),
}));

vi.mock('../../src/lib/config.js', () => ({ env: mocks.env }));
vi.mock('../../src/lib/clickhouse/client.js', () => ({
  get clickhouse() {
    return mocks.generalClient;
  },
}));
vi.mock('../../src/lib/budget-projection/clickhouse-client.js', () => ({
  getBudgetProjectionClickHouseClient: mocks.getClient,
  getBudgetProjectionClickHouseClientMetadata: mocks.getMetadata,
}));

import {
  BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS,
  BudgetProjectionClickHouseConfigError,
} from '../../src/lib/budget-projection/clickhouse-config.js';
import {
  BudgetProjectionClickHouseNotReadyError,
  _resetBudgetProjectionClickHousePostureForTests,
  assertBudgetProjectionClickHouseReadyForProduction,
  attestBudgetProjectionClickHouse,
  getBudgetProjectionClickHousePosture,
  getReadyBudgetProjectionClickHouseClient,
  type BudgetProjectionClickHousePostureClient,
} from '../../src/lib/budget-projection/clickhouse-posture.js';

const DATABASE = 'pylva';
const PROJECTOR_ROLE = 'pylva_authoritative_budget_projector';
const GENERAL_ROLE = 'pylva_general_app_runtime';
const PROJECTOR_DIRECT = `GRANT ${PROJECTOR_ROLE} TO budget_projector`;
const GENERAL_DIRECT = `GRANT ${GENERAL_ROLE} TO app_reader`;
const PROJECTOR_ROLE_GRANTS = `GRANT SELECT, INSERT ON ${DATABASE}.budget_cost_events TO ${PROJECTOR_ROLE}`;
const GENERAL_ROLE_GRANTS = [
  `GRANT SELECT ON ${DATABASE}.* TO ${GENERAL_ROLE}`,
  `GRANT INSERT, ALTER UPDATE(cost_usd, pricing_status) ON ${DATABASE}.cost_events TO ${GENERAL_ROLE}`,
];

function stream(value: string): AsyncIterable<unknown> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(value);
    },
  };
}

function postureClient(options: {
  currentRoles?: unknown;
  database?: string;
  defaultRoles?: unknown;
  directGrants?: string[];
  enabledRoles?: unknown;
  roleGrants?: string[];
  username: string;
}): BudgetProjectionClickHousePostureClient {
  return {
    query: vi.fn(async () => {
      const role = options.username.includes('projector') ? PROJECTOR_ROLE : GENERAL_ROLE;
      return {
        json: async () => [
          {
            current_user: options.username,
            current_database: options.database ?? DATABASE,
            current_roles: options.currentRoles ?? [role],
            enabled_roles: options.enabledRoles ?? [role],
            default_roles: options.defaultRoles ?? [role],
          },
        ],
      };
    }),
    exec: vi.fn(async ({ query }) => {
      const projector = options.username.includes('projector');
      if (query === 'SHOW GRANTS') {
        const defaults = projector ? [PROJECTOR_DIRECT] : [GENERAL_DIRECT];
        return { stream: stream(`${(options.directGrants ?? defaults).join('\n')}\n`) };
      }
      if (query === `SHOW GRANTS FOR "${projector ? PROJECTOR_ROLE : GENERAL_ROLE}"`) {
        const defaults = projector ? [PROJECTOR_ROLE_GRANTS] : GENERAL_ROLE_GRANTS;
        return { stream: stream(`${(options.roleGrants ?? defaults).join('\n')}\n`) };
      }
      return { stream: stream('') };
    }),
  };
}

const METADATA = {
  database: DATABASE,
  expectedGeneralRole: GENERAL_ROLE,
  expectedGeneralUsername: 'app_reader',
  expectedProjectorRole: PROJECTOR_ROLE,
  expectedProjectorUsername: 'budget_projector',
  source: 'dedicated' as const,
};

beforeEach(() => {
  mocks.env.NODE_ENV = 'production';
  mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = true;
  mocks.projectorClient = postureClient({
    username: 'budget_projector',
  }) as unknown as ClickHouseClient;
  mocks.generalClient = postureClient({
    username: 'app_reader',
  }) as unknown as ClickHouseClient;
  mocks.getClient.mockReset();
  mocks.getClient.mockReturnValue(mocks.projectorClient);
  mocks.getMetadata.mockReset();
  mocks.getMetadata.mockReturnValue(METADATA);
  _resetBudgetProjectionClickHousePostureForTests();
});

describe('authoritative projector ClickHouse grant attestation', () => {
  it('accepts only the isolated projector and general read/legacy-ingest matrix', async () => {
    await expect(
      attestBudgetProjectionClickHouse(
        postureClient({ username: 'budget_projector' }),
        postureClient({ username: 'app_reader' }),
        METADATA,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    [
      'identity_mismatch',
      postureClient({ username: 'wrong_projector' }),
      postureClient({ username: 'app_reader' }),
    ],
    [
      'target_mismatch',
      postureClient({
        username: 'budget_projector',
        database: 'other',
      }),
      postureClient({ username: 'app_reader' }),
    ],
    [
      'projector_grant_missing',
      postureClient({
        username: 'budget_projector',
        roleGrants: [],
      }),
      postureClient({ username: 'app_reader' }),
    ],
    [
      'projector_role_contract_invalid',
      postureClient({
        username: 'budget_projector',
        directGrants: [PROJECTOR_DIRECT, 'GRANT unexpected_role TO budget_projector'],
      }),
      postureClient({ username: 'app_reader' }),
    ],
    [
      'projector_effective_grants_mismatch',
      postureClient({
        username: 'budget_projector',
        roleGrants: [
          PROJECTOR_ROLE_GRANTS,
          `GRANT ALTER UPDATE ON ${DATABASE}.cost_daily_agg TO ${PROJECTOR_ROLE}`,
        ],
      }),
      postureClient({ username: 'app_reader' }),
    ],
    [
      'general_read_grant_missing',
      postureClient({ username: 'budget_projector' }),
      postureClient({
        username: 'app_reader',
        roleGrants: [GENERAL_ROLE_GRANTS[1]!],
      }),
    ],
    [
      'legacy_ingest_grant_missing',
      postureClient({ username: 'budget_projector' }),
      postureClient({
        username: 'app_reader',
        roleGrants: [
          GENERAL_ROLE_GRANTS[0]!,
          `GRANT ALTER UPDATE(cost_usd, pricing_status) ON ${DATABASE}.cost_events TO ${GENERAL_ROLE}`,
        ],
      }),
    ],
    [
      'legacy_backfill_grant_missing',
      postureClient({ username: 'budget_projector' }),
      postureClient({
        username: 'app_reader',
        roleGrants: [
          GENERAL_ROLE_GRANTS[0]!,
          `GRANT INSERT ON ${DATABASE}.cost_events TO ${GENERAL_ROLE}`,
        ],
      }),
    ],
    [
      'general_effective_grants_mismatch',
      postureClient({ username: 'budget_projector' }),
      postureClient({
        username: 'app_reader',
        roleGrants: [
          ...GENERAL_ROLE_GRANTS,
          `GRANT ALTER DELETE ON ${DATABASE}.budget_cost_events TO ${GENERAL_ROLE}`,
        ],
      }),
    ],
  ] as const)('returns %s for a matrix violation', async (reason, projector, general) => {
    await expect(attestBudgetProjectionClickHouse(projector, general, METADATA)).resolves.toBe(
      reason,
    );
  });

  it.each([
    `GRANT INSERT ON ${DATABASE}.cost_daily_agg TO budget_projector`,
    `GRANT ALTER UPDATE ON ${DATABASE}.budget_cost_events TO budget_projector`,
    `GRANT ALTER DELETE ON ${DATABASE}.budget_cost_events TO budget_projector`,
    `GRANT ALTER TABLE ON ${DATABASE}.* TO budget_projector`,
    `GRANT OPTIMIZE ON ${DATABASE}.* TO budget_projector`,
    `GRANT CREATE VIEW ON ${DATABASE}.* TO budget_projector`,
    `GRANT CREATE DICTIONARY ON ${DATABASE}.* TO budget_projector`,
    'GRANT CREATE FUNCTION ON *.* TO budget_projector',
    'GRANT CREATE TEMPORARY TABLE ON *.* TO budget_projector',
    'GRANT CREATE ARBITRARY TEMPORARY TABLE ON *.* TO budget_projector',
    'GRANT SYSTEM ON *.* TO budget_projector',
    'GRANT KILL QUERY ON *.* TO budget_projector',
    'GRANT SOURCES ON *.* TO budget_projector',
  ])('rejects projector privilege drift: %s', async (extraGrant) => {
    await expect(
      attestBudgetProjectionClickHouse(
        postureClient({
          username: 'budget_projector',
          roleGrants: [PROJECTOR_ROLE_GRANTS, extraGrant],
        }),
        postureClient({ username: 'app_reader' }),
        METADATA,
      ),
    ).resolves.toBe('projector_effective_grants_mismatch');
  });

  it.each([
    `GRANT INSERT ON ${DATABASE}.budget_cost_events TO app_reader`,
    `GRANT ALTER UPDATE ON ${DATABASE}.budget_cost_events TO app_reader`,
    `GRANT ALTER DELETE ON ${DATABASE}.budget_cost_events TO app_reader`,
    `GRANT OPTIMIZE ON ${DATABASE}.budget_cost_events TO app_reader`,
  ])('rejects general authoritative mutation drift: %s', async (extraGrant) => {
    await expect(
      attestBudgetProjectionClickHouse(
        postureClient({ username: 'budget_projector' }),
        postureClient({
          username: 'app_reader',
          roleGrants: [...GENERAL_ROLE_GRANTS, extraGrant],
        }),
        METADATA,
      ),
    ).resolves.toBe('general_effective_grants_mismatch');
  });

  it('fails malformed role-state output closed', async () => {
    await expect(
      attestBudgetProjectionClickHouse(
        postureClient({ username: 'budget_projector', currentRoles: 'not-an-array' }),
        postureClient({ username: 'app_reader' }),
        METADATA,
      ),
    ).resolves.toBe('invalid_attestation');
  });
});

describe('production authoritative projector posture', () => {
  it('coalesces success only for a bounded window, then detects privilege drift', async () => {
    let now = 1_000_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const first = await getBudgetProjectionClickHousePosture();
    const second = await getBudgetProjectionClickHousePosture();
    expect(first).toEqual({
      ready: true,
      reason: null,
      attested: true,
      credential_source: 'dedicated',
    });
    expect(second).toEqual(first);
    expect(mocks.getClient).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain('budget_projector');
    await expect(getReadyBudgetProjectionClickHouseClient()).resolves.toBe(mocks.projectorClient);

    mocks.projectorClient = postureClient({
      username: 'budget_projector',
      roleGrants: [PROJECTOR_ROLE_GRANTS, `GRANT ALTER ON ${DATABASE}.* TO ${PROJECTOR_ROLE}`],
    }) as unknown as ClickHouseClient;
    mocks.getClient.mockReturnValue(mocks.projectorClient);
    now += BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS + 1;
    await expect(getBudgetProjectionClickHousePosture()).resolves.toMatchObject({
      ready: false,
      reason: 'projector_effective_grants_mismatch',
    });
    expect(mocks.getClient).toHaveBeenCalledTimes(3);
    clock.mockRestore();
  });

  it('does not cache a deterministic rejection after an operator repairs posture', async () => {
    mocks.getMetadata
      .mockImplementationOnce(() => {
        throw new BudgetProjectionClickHouseConfigError('credential_reuse', 'sensitive detail');
      })
      .mockReturnValue(METADATA);
    await expect(getBudgetProjectionClickHousePosture()).resolves.toMatchObject({ ready: false });
    await expect(getBudgetProjectionClickHousePosture()).resolves.toMatchObject({ ready: true });
    expect(mocks.getMetadata).toHaveBeenCalledTimes(2);
  });

  it('maps secret-safe deterministic configuration failures and blocks the default path', async () => {
    mocks.getMetadata.mockImplementation(() => {
      throw new BudgetProjectionClickHouseConfigError(
        'credential_reuse',
        'a secret-bearing test detail',
      );
    });
    await expect(getBudgetProjectionClickHousePosture()).resolves.toEqual({
      ready: false,
      reason: 'credential_isolation_failed',
      attested: false,
      credential_source: null,
    });
    await expect(getReadyBudgetProjectionClickHouseClient()).rejects.toEqual(
      expect.objectContaining<Partial<BudgetProjectionClickHouseNotReadyError>>({
        name: 'BudgetProjectionClickHouseNotReadyError',
        reason: 'credential_isolation_failed',
        status: 503,
      }),
    );
  });

  it('retries an attestation transport failure rather than pinning a rejection', async () => {
    const failing = postureClient({ username: 'budget_projector' });
    failing.query = vi.fn().mockRejectedValueOnce(new Error('temporary network failure'));
    mocks.projectorClient = failing as unknown as ClickHouseClient;
    mocks.getClient.mockReturnValue(mocks.projectorClient);

    await expect(getBudgetProjectionClickHousePosture()).resolves.toMatchObject({
      ready: false,
      reason: 'attestation_query_failed',
    });
    mocks.projectorClient = postureClient({
      username: 'budget_projector',
    }) as unknown as ClickHouseClient;
    mocks.getClient.mockReturnValue(mocks.projectorClient);
    await expect(getBudgetProjectionClickHousePosture()).resolves.toMatchObject({ ready: true });
    expect(mocks.getClient).toHaveBeenCalledTimes(2);
  });

  it('uses explicit local/test configuration without claiming grant attestation', async () => {
    mocks.env.NODE_ENV = 'test';
    mocks.getMetadata.mockReturnValue({ ...METADATA, source: 'local_ci_fallback' });
    _resetBudgetProjectionClickHousePostureForTests();
    await expect(getBudgetProjectionClickHousePosture()).resolves.toEqual({
      ready: true,
      reason: null,
      attested: false,
      credential_source: 'local_ci_fallback',
    });
  });

  it('attests the production projector while new authoritative reservations are disabled', async () => {
    mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;
    await expect(assertBudgetProjectionClickHouseReadyForProduction()).resolves.toBeUndefined();
    expect(mocks.getClient).toHaveBeenCalledTimes(1);
  });

  it('fails production boot with the feature flag off when the projector credential is missing', async () => {
    mocks.env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL = false;
    mocks.getMetadata.mockImplementation(() => {
      throw new BudgetProjectionClickHouseConfigError('missing_url', 'sensitive detail');
    });

    await expect(assertBudgetProjectionClickHouseReadyForProduction()).rejects.toEqual(
      expect.objectContaining<Partial<BudgetProjectionClickHouseNotReadyError>>({
        name: 'BudgetProjectionClickHouseNotReadyError',
        reason: 'credential_missing',
        status: 503,
      }),
    );
    expect(mocks.getClient).not.toHaveBeenCalled();
  });

  it('attests the production projector when authoritative control is enabled', async () => {
    await expect(assertBudgetProjectionClickHouseReadyForProduction()).resolves.toBeUndefined();
    expect(mocks.getClient).toHaveBeenCalledTimes(1);
  });

  it('does not require grant attestation in local/test processes', async () => {
    mocks.env.NODE_ENV = 'test';
    await expect(assertBudgetProjectionClickHouseReadyForProduction()).resolves.toBeUndefined();
    expect(mocks.getClient).not.toHaveBeenCalled();
  });

  it('fails production boot closed when an enabled projector is unsafe', async () => {
    mocks.getMetadata.mockImplementation(() => {
      throw new BudgetProjectionClickHouseConfigError('credential_reuse', 'sensitive detail');
    });

    await expect(assertBudgetProjectionClickHouseReadyForProduction()).rejects.toEqual(
      expect.objectContaining<Partial<BudgetProjectionClickHouseNotReadyError>>({
        name: 'BudgetProjectionClickHouseNotReadyError',
        reason: 'credential_isolation_failed',
        status: 503,
      }),
    );
    expect(mocks.getClient).not.toHaveBeenCalled();
  });
});
