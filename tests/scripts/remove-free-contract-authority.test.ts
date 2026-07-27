import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeChecksum, REMOVE_FREE_FRESH_INSTALL_GUC } from '../../scripts/db-migrate-core.js';
import { runDbMigrate } from '../../scripts/db-migrate.js';
import {
  assertRemoveFreeContractTaskRole,
  isRemoveFreeContractTaskRoleArn,
  REMOVE_FREE_CONTRACT_TASK_ROLE_SUFFIX,
  type EcsTaskMetadataFetch,
  type StsCallerIdentityClient,
} from '../../scripts/remove-free-contract-authority.js';
import { createRecordingSqlClient } from '../_helpers/migration-sql-mock.js';

const CONTRACT_ROLE_ARN =
  'arn:aws:sts::123456789012:assumed-role/pylva-prod-ecs-remove-free-contract-task/github-123';
const CONTRACT_TASK_ARN =
  'arn:aws:ecs:us-east-1:123456789012:task/pylva-prod/0123456789abcdef0123456789abcdef';
const METADATA_URI = 'http://169.254.170.2/v4/0123456789abcdef0123456789abcdef';

let rootDir = '';
let migrationsDir = '';

beforeEach(async () => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pylva-contract-authority-'));
  migrationsDir = path.join(rootDir, 'db/migrations');
  await fs.mkdir(migrationsDir, { recursive: true });
});

afterEach(async () => {
  if (rootDir !== '') {
    await fs.rm(rootDir, { force: true, recursive: true });
  }
});

async function writeMigration(filename: string, content: string): Promise<void> {
  await fs.writeFile(path.join(migrationsDir, filename), content, 'utf8');
}

async function writeHostedContractArtifact(): Promise<Record<string, string>> {
  const contents = {
    '056_workspace_access_state_expand.sql': "SELECT '056';",
    '057_hosted_workspace_entitlements.sql': "SELECT '057';",
    '058_remove_free_plan_contract.sql': "SELECT '058';",
    '059_hosted_remove_free_contract.sql': "SELECT '059';",
  };
  for (const [filename, content] of Object.entries(contents)) {
    await writeMigration(filename, content);
  }
  await fs.writeFile(
    path.join(rootDir, 'db/migration-phases.json'),
    JSON.stringify({
      default: 'pre_roll',
      overrides: {
        '058_remove_free_plan_contract.sql': 'post_roll',
        '059_hosted_remove_free_contract.sql': 'post_roll',
      },
    }),
    'utf8',
  );
  return contents;
}

function appliedExpandLedger(contents: Record<string, string>) {
  return ['056_workspace_access_state_expand.sql', '057_hosted_workspace_entitlements.sql'].map(
    (filename) => ({
      filename,
      checksum: computeChecksum(contents[filename]!),
    }),
  );
}

describe('hosted remove-Free contract task-role attestation', () => {
  it('accepts only an STS assumed-role ARN with the exact dedicated role suffix', () => {
    expect(REMOVE_FREE_CONTRACT_TASK_ROLE_SUFFIX).toBe('-ecs-remove-free-contract-task');
    expect(isRemoveFreeContractTaskRoleArn(CONTRACT_ROLE_ARN)).toBe(true);
    expect(
      isRemoveFreeContractTaskRoleArn(
        'arn:aws-us-gov:sts::123456789012:assumed-role/pylva-prod-ecs-remove-free-contract-task/session',
      ),
    ).toBe(true);

    for (const arn of [
      undefined,
      '',
      'arn:aws:iam::123456789012:role/pylva-prod-ecs-remove-free-contract-task',
      'arn:aws:sts::123456789012:assumed-role/pylva-prod-ecs-task/session',
      'arn:aws:sts::123456789012:assumed-role/pylva-prod-ecs-remove-free-contract-task-extra/session',
      'arn:aws:sts::123456789012:assumed-role/path/pylva-prod-ecs-remove-free-contract-task/session',
      'arn:aws:sts::not-an-account:assumed-role/pylva-prod-ecs-remove-free-contract-task/session',
      'arn:aws:sts::123456789012:assumed-role/pylva-prod-ecs-remove-free-contract-task/',
    ]) {
      expect(isRemoveFreeContractTaskRoleArn(arn)).toBe(false);
    }
  });

  it('binds STS identity to the same-account dedicated ECS family and exact task metadata endpoint', async () => {
    const send = vi.fn<StsCallerIdentityClient['send']>().mockResolvedValue({
      Arn: CONTRACT_ROLE_ARN,
      Account: '123456789012',
      UserId: 'test',
      $metadata: {},
    });
    const fetchTaskMetadata = vi.fn<EcsTaskMetadataFetch>(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          TaskARN: CONTRACT_TASK_ARN,
          Family: 'pylva-prod-remove-free-contract-migrations',
        }),
    }));

    await expect(
      assertRemoveFreeContractTaskRole({
        stsClient: { send },
        ecsContainerMetadataUriV4: METADATA_URI,
        fetchTaskMetadata,
      }),
    ).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(GetCallerIdentityCommand);
    expect(fetchTaskMetadata).toHaveBeenCalledTimes(1);
    expect(fetchTaskMetadata.mock.calls[0]?.[0]).toBe(`${METADATA_URI}/task`);
    expect(fetchTaskMetadata.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      redirect: 'error',
    });
  });

  it('rejects non-link-local metadata URIs before STS or fetch', async () => {
    for (const uri of [
      undefined,
      '',
      'https://169.254.170.2/v4/task-id',
      'http://169.254.170.3/v4/task-id',
      'http://169.254.170.2:80/v4/task-id',
      'http://user@169.254.170.2/v4/task-id',
      'http://169.254.170.2/v4/task-id/extra',
      'http://169.254.170.2/v4/%2e%2e',
      'http://169.254.170.2/v4/.',
      'http://169.254.170.2/v4/..',
      'http://169.254.170.2/v4/task-id?redirect=evil',
    ]) {
      const send = vi.fn<StsCallerIdentityClient['send']>();
      const fetchTaskMetadata = vi.fn();
      await expect(
        assertRemoveFreeContractTaskRole({
          stsClient: { send },
          ecsContainerMetadataUriV4: uri,
          fetchTaskMetadata,
        }),
      ).rejects.toThrow('matching STS and ECS task-metadata identity');
      expect(send).not.toHaveBeenCalled();
      expect(fetchTaskMetadata).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      name: 'missing STS ARN',
      sts: { Arn: undefined, Account: '123456789012', $metadata: {} },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: 'pylva-prod-remove-free-contract-migrations',
      },
    },
    {
      name: 'ordinary task role',
      sts: {
        Arn: 'arn:aws:sts::123456789012:assumed-role/pylva-prod-ecs-task/session',
        Account: '123456789012',
        $metadata: {},
      },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: 'pylva-prod-remove-free-contract-migrations',
      },
    },
    {
      name: 'STS Account disagrees with its ARN',
      sts: {
        Arn: CONTRACT_ROLE_ARN,
        Account: '999999999999',
        $metadata: {},
      },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: 'pylva-prod-remove-free-contract-migrations',
      },
    },
    {
      name: 'external-account assumed role credentials',
      sts: {
        Arn: 'arn:aws:sts::999999999999:assumed-role/pylva-prod-ecs-remove-free-contract-task/session',
        Account: '999999999999',
        $metadata: {},
      },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: 'pylva-prod-remove-free-contract-migrations',
      },
    },
    {
      name: 'ordinary migration family',
      sts: {
        Arn: CONTRACT_ROLE_ARN,
        Account: '123456789012',
        $metadata: {},
      },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: 'pylva-prod-migrations',
      },
    },
    {
      name: 'different-prefix contract family',
      sts: {
        Arn: CONTRACT_ROLE_ARN,
        Account: '123456789012',
        $metadata: {},
      },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: 'other-prod-remove-free-contract-migrations',
      },
    },
    {
      name: 'different task partition',
      sts: {
        Arn: CONTRACT_ROLE_ARN,
        Account: '123456789012',
        $metadata: {},
      },
      task: {
        TaskARN:
          'arn:aws-us-gov:ecs:us-gov-west-1:123456789012:task/pylva-prod/0123456789abcdef0123456789abcdef',
        Family: 'pylva-prod-remove-free-contract-migrations',
      },
    },
    {
      name: 'missing task family',
      sts: {
        Arn: CONTRACT_ROLE_ARN,
        Account: '123456789012',
        $metadata: {},
      },
      task: {
        TaskARN: CONTRACT_TASK_ARN,
        Family: undefined,
      },
    },
    {
      name: 'malformed task ARN',
      sts: {
        Arn: CONTRACT_ROLE_ARN,
        Account: '123456789012',
        $metadata: {},
      },
      task: {
        TaskARN: 'not-an-arn',
        Family: 'pylva-prod-remove-free-contract-migrations',
      },
    },
  ])('fails closed for $name without disclosing observed identities', async ({ sts, task }) => {
    const denied = {
      send: vi.fn<StsCallerIdentityClient['send']>().mockResolvedValue(sts),
    };
    const error = await assertRemoveFreeContractTaskRole({
      stsClient: denied,
      ecsContainerMetadataUriV4: METADATA_URI,
      fetchTaskMetadata: async () => ({
        ok: true,
        text: async () => JSON.stringify(task),
      }),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'matching STS and ECS task-metadata identity for the dedicated contract task',
    );
    expect((error as Error).message).not.toContain(String(sts.Arn));
    expect((error as Error).message).not.toContain(String(task.TaskARN));
    expect((error as Error).message).not.toContain(String(task.Family));
  });

  it('fails closed on STS or task-metadata transport and parsing errors', async () => {
    const validSts = {
      send: vi.fn<StsCallerIdentityClient['send']>().mockResolvedValue({
        Arn: CONTRACT_ROLE_ARN,
        Account: '123456789012',
        $metadata: {},
      }),
    };

    for (const fetchTaskMetadata of [
      async () => {
        throw new Error('metadata-secret-detail');
      },
      async () => ({ ok: false, text: async () => 'provider-secret-detail' }),
      async () => ({ ok: true, text: async () => '{malformed-json' }),
      async () => ({ ok: true, text: async () => 'x'.repeat(65 * 1024) }),
    ]) {
      const error = await assertRemoveFreeContractTaskRole({
        stsClient: validSts,
        ecsContainerMetadataUriV4: METADATA_URI,
        fetchTaskMetadata,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain('secret-detail');
      expect((error as Error).message).toContain('matching STS and ECS task-metadata identity');
    }

    const unavailable = {
      send: vi
        .fn<StsCallerIdentityClient['send']>()
        .mockRejectedValue(new Error('credential-secret-detail')),
    };
    const error = await assertRemoveFreeContractTaskRole({
      stsClient: unavailable,
      ecsContainerMetadataUriV4: METADATA_URI,
      fetchTaskMetadata: async () => ({
        ok: true,
        text: async () =>
          JSON.stringify({
            TaskARN: CONTRACT_TASK_ARN,
            Family: 'pylva-prod-remove-free-contract-migrations',
          }),
      }),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain('credential-secret-detail');
  });

  it('attests before any database access when hosted migration 059 and the contract flag are present', async () => {
    const contents = await writeHostedContractArtifact();
    const { client, calls } = createRecordingSqlClient({
      ledgerRows: appliedExpandLedger(contents),
    });
    const assertHostedContractAuthority = vi.fn(async () => {
      expect(calls).toHaveLength(0);
    });
    const errors: string[] = [];

    const exitCode = await runDbMigrate(
      {
        mode: 'apply',
        phase: 'post_roll',
        yes: false,
        json: false,
        approveRemoveFreeContract: true,
      },
      {
        sql: client,
        migrationsDir,
        log: () => undefined,
        error: (line) => errors.push(line),
        assertHostedContractAuthority,
      },
    );

    expect(exitCode, errors.join('\n')).toBe(0);
    expect(assertHostedContractAuthority).toHaveBeenCalledTimes(1);
    expect(
      calls
        .filter((call) => call.kind === 'tx.unsafe')
        .filter((call) => call.query?.startsWith('SELECT '))
        .map((call) => ({ query: call.query, params: call.params })),
    ).toEqual([
      {
        query: 'SELECT pg_catalog.set_config($1, $2, true)',
        params: [REMOVE_FREE_FRESH_INSTALL_GUC, 'off'],
      },
      { query: "SELECT '058';", params: undefined },
      {
        query: 'SELECT pg_catalog.set_config($1, $2, true)',
        params: [REMOVE_FREE_FRESH_INSTALL_GUC, 'off'],
      },
      { query: "SELECT '059';", params: undefined },
    ]);
  });

  it('returns a fail-closed error and performs no database access when attestation fails', async () => {
    const contents = await writeHostedContractArtifact();
    const { client, calls } = createRecordingSqlClient({
      ledgerRows: appliedExpandLedger(contents),
    });
    const errors: string[] = [];

    const exitCode = await runDbMigrate(
      {
        mode: 'apply',
        phase: 'post_roll',
        yes: false,
        json: false,
        approveRemoveFreeContract: true,
      },
      {
        sql: client,
        migrationsDir,
        log: () => undefined,
        error: (line) => errors.push(line),
        assertHostedContractAuthority: async () => {
          throw new Error('dedicated contract task role required');
        },
      },
    );

    expect(exitCode).toBe(4);
    expect(errors).toEqual(['dedicated contract task role required']);
    expect(calls).toEqual([]);
  });

  it('does not require hosted STS attestation when migration 059 is absent', async () => {
    await writeMigration('056_workspace_access_state_expand.sql', "SELECT '056';");
    await writeMigration('058_remove_free_plan_contract.sql', "SELECT '058';");
    await fs.writeFile(
      path.join(rootDir, 'db/migration-phases.json'),
      JSON.stringify({
        default: 'pre_roll',
        overrides: { '058_remove_free_plan_contract.sql': 'post_roll' },
      }),
      'utf8',
    );
    const { client } = createRecordingSqlClient({
      ledgerRows: [
        {
          filename: '056_workspace_access_state_expand.sql',
          checksum: computeChecksum("SELECT '056';"),
        },
      ],
    });
    const assertHostedContractAuthority = vi.fn(async () => undefined);

    const exitCode = await runDbMigrate(
      {
        mode: 'apply',
        phase: 'post_roll',
        yes: false,
        json: false,
        approveRemoveFreeContract: true,
      },
      {
        sql: client,
        migrationsDir,
        log: () => undefined,
        error: () => undefined,
        assertHostedContractAuthority,
      },
    );

    expect(exitCode).toBe(0);
    expect(assertHostedContractAuthority).not.toHaveBeenCalled();
  });
});
