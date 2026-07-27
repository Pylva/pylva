import {
  GetCallerIdentityCommand,
  STSClient,
  type GetCallerIdentityCommandOutput,
} from '@aws-sdk/client-sts';

export const HOSTED_REMOVE_FREE_CONTRACT_MIGRATION = '059_hosted_remove_free_contract.sql';
export const REMOVE_FREE_CONTRACT_TASK_ROLE_SUFFIX = '-ecs-remove-free-contract-task';

const AUTHORITY_ERROR =
  'hosted remove-Free contract approval requires matching STS and ECS task-metadata identity for the dedicated contract task';
const ECS_TASK_METADATA_MAX_BYTES = 64 * 1024;
const ECS_TASK_METADATA_TIMEOUT_MS = 3_000;

export interface StsCallerIdentityClient {
  send(command: GetCallerIdentityCommand): Promise<GetCallerIdentityCommandOutput>;
}

export interface EcsTaskMetadataResponse {
  ok: boolean;
  text(): Promise<string>;
}

export type EcsTaskMetadataFetch = (
  input: string,
  init: {
    method: 'GET';
    redirect: 'error';
    signal: AbortSignal;
  },
) => Promise<EcsTaskMetadataResponse>;

export interface RemoveFreeContractAuthorityDeps {
  stsClient?: StsCallerIdentityClient;
  ecsContainerMetadataUriV4?: string;
  fetchTaskMetadata?: EcsTaskMetadataFetch;
}

interface ContractRoleIdentity {
  partition: 'aws' | 'aws-cn' | 'aws-us-gov';
  accountId: string;
  prefix: string;
}

function authorityError(): Error {
  return new Error(AUTHORITY_ERROR);
}

function contractRoleIdentity(arn: string | undefined): ContractRoleIdentity | null {
  if (arn === undefined) return null;

  const match =
    /^arn:(aws|aws-cn|aws-us-gov):sts::([0-9]{12}):assumed-role\/([A-Za-z0-9+=,.@_-]+)\/[A-Za-z0-9+=,.@_-]+$/u.exec(
      arn,
    );
  const roleName = match?.[3];
  if (
    match === null ||
    roleName === undefined ||
    !roleName.endsWith(REMOVE_FREE_CONTRACT_TASK_ROLE_SUFFIX)
  ) {
    return null;
  }

  const prefix = roleName.slice(0, -REMOVE_FREE_CONTRACT_TASK_ROLE_SUFFIX.length);
  if (prefix === '' || !/^[A-Za-z0-9+=,.@_-]+$/u.test(prefix)) {
    return null;
  }

  return {
    partition: match[1] as ContractRoleIdentity['partition'],
    accountId: match[2]!,
    prefix,
  };
}

export function isRemoveFreeContractTaskRoleArn(arn: string | undefined): boolean {
  return contractRoleIdentity(arn) !== null;
}

function taskMetadataUrl(rawUri: string | undefined): string | null {
  if (rawUri === undefined) return null;
  const match = /^http:\/\/169\.254\.170\.2\/v4\/([A-Za-z0-9._~-]+)$/u.exec(rawUri);
  const opaqueId = match?.[1];
  if (opaqueId === undefined || opaqueId === '.' || opaqueId === '..') return null;
  return `${rawUri}/task`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function taskIdentity(
  metadata: unknown,
): { partition: string; region: string; accountId: string; family: string } | null {
  if (!isRecord(metadata) || typeof metadata.TaskARN !== 'string') {
    return null;
  }
  const match =
    /^arn:(aws|aws-cn|aws-us-gov):ecs:([a-z0-9-]+):([0-9]{12}):task\/(?:[A-Za-z0-9_-]+\/)?[A-Za-z0-9-]+$/u.exec(
      metadata.TaskARN,
    );
  if (match === null || typeof metadata.Family !== 'string') {
    return null;
  }
  return {
    partition: match[1]!,
    region: match[2]!,
    accountId: match[3]!,
    family: metadata.Family,
  };
}

async function readTaskMetadata(
  taskUrl: string,
  fetchTaskMetadata: EcsTaskMetadataFetch,
): Promise<unknown> {
  const response = await fetchTaskMetadata(taskUrl, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(ECS_TASK_METADATA_TIMEOUT_MS),
  });
  if (!response.ok) throw authorityError();

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > ECS_TASK_METADATA_MAX_BYTES) {
    throw authorityError();
  }
  return JSON.parse(text) as unknown;
}

/**
 * Attest the supported hosted contraction path to the dedicated ECS task role.
 *
 * This narrows use of the migration CLI approval flag; it is not a database
 * authorization boundary because other principals with database credentials
 * can issue equivalent SQL outside this CLI.
 */
export async function assertRemoveFreeContractTaskRole(
  deps: RemoveFreeContractAuthorityDeps = {},
): Promise<void> {
  try {
    const taskUrl = taskMetadataUrl(
      deps.ecsContainerMetadataUriV4 ?? process.env.ECS_CONTAINER_METADATA_URI_V4,
    );
    if (taskUrl === null) throw authorityError();

    const metadata = await readTaskMetadata(
      taskUrl,
      deps.fetchTaskMetadata ?? (fetch as EcsTaskMetadataFetch),
    );
    const task = taskIdentity(metadata);
    if (task === null) throw authorityError();

    // ECS does not promise an AWS_REGION environment variable. Deriving the
    // client region from the link-local task ARN keeps the default STS call
    // usable without trusting a caller-controlled region override.
    const identity = await (deps.stsClient ?? new STSClient({ region: task.region })).send(
      new GetCallerIdentityCommand({}),
    );
    const role = contractRoleIdentity(identity.Arn);

    if (
      role === null ||
      identity.Account !== role.accountId ||
      task.partition !== role.partition ||
      task.accountId !== role.accountId ||
      task.family !== `${role.prefix}-remove-free-contract-migrations`
    ) {
      throw authorityError();
    }
  } catch {
    throw authorityError();
  }
}
