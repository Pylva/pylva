import type { ClickHouseClient } from '@clickhouse/client';
import { env } from '../config.js';
import { clickhouse as generalClickHouse } from '../clickhouse/client.js';
import {
  getBudgetProjectionClickHouseClient,
  getBudgetProjectionClickHouseClientMetadata,
} from './clickhouse-client.js';
import {
  BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS,
  BudgetProjectionClickHouseConfigError,
} from './clickhouse-config.js';
import {
  exactGrantLines,
  expectedAuthoritativeBudgetClickHouseGrants,
  quoteClickHouseIdentifier,
} from './clickhouse-rbac.js';

export type BudgetProjectionClickHousePostureReason =
  | 'attestation_query_failed'
  | 'credential_invalid'
  | 'credential_isolation_failed'
  | 'credential_missing'
  | 'general_effective_grants_mismatch'
  | 'general_read_grant_missing'
  | 'general_role_contract_invalid'
  | 'identity_mismatch'
  | 'invalid_attestation'
  | 'legacy_backfill_grant_missing'
  | 'legacy_ingest_grant_missing'
  | 'projector_effective_grants_mismatch'
  | 'projector_grant_missing'
  | 'projector_role_contract_invalid'
  | 'target_mismatch';

export type BudgetProjectionClickHousePosture =
  | {
      ready: true;
      reason: null;
      attested: boolean;
      credential_source: 'dedicated' | 'local_ci_fallback';
    }
  | {
      ready: false;
      reason: BudgetProjectionClickHousePostureReason;
      attested: false;
      credential_source: null;
    };

interface JsonResult {
  json(): Promise<unknown>;
}

interface ExecResult {
  stream: AsyncIterable<unknown>;
}

export interface BudgetProjectionClickHousePostureClient {
  exec(input: { query: string; abort_signal?: AbortSignal }): Promise<ExecResult>;
  query(input: {
    query: string;
    format: 'JSONEachRow';
    abort_signal?: AbortSignal;
  }): Promise<JsonResult>;
}

export interface BudgetProjectionClickHouseAttestationMetadata {
  database: string;
  expectedGeneralRole: string;
  expectedGeneralUsername: string;
  expectedProjectorRole: string;
  expectedProjectorUsername: string;
}

interface IdentityRow {
  current_database?: unknown;
  current_roles?: unknown;
  current_user?: unknown;
  default_roles?: unknown;
  enabled_roles?: unknown;
}

const ATTESTATION_TIMEOUT_MS = 10_000;

async function identity(client: BudgetProjectionClickHousePostureClient): Promise<{
  currentRoles: string[];
  database: string;
  defaultRoles: string[];
  enabledRoles: string[];
  username: string;
} | null> {
  const response = await client.query({
    query: `SELECT currentUser() AS current_user,
                   currentDatabase() AS current_database,
                   currentRoles() AS current_roles,
                   enabledRoles() AS enabled_roles,
                   defaultRoles() AS default_roles`,
    format: 'JSONEachRow',
    abort_signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
  });
  const raw = await response.json();
  if (!Array.isArray(raw) || raw.length !== 1) return null;
  const row = raw[0] as IdentityRow;
  if (
    typeof row.current_user !== 'string' ||
    typeof row.current_database !== 'string' ||
    !Array.isArray(row.current_roles) ||
    !Array.isArray(row.enabled_roles) ||
    !Array.isArray(row.default_roles) ||
    row.current_roles.some((role) => typeof role !== 'string') ||
    row.enabled_roles.some((role) => typeof role !== 'string') ||
    row.default_roles.some((role) => typeof role !== 'string')
  ) {
    return null;
  }
  return {
    currentRoles: row.current_roles as string[],
    database: row.current_database,
    defaultRoles: row.default_roles as string[],
    enabledRoles: row.enabled_roles as string[],
    username: row.current_user,
  };
}

async function readExecText(
  client: BudgetProjectionClickHousePostureClient,
  query: string,
  maxLength: number,
): Promise<string | null> {
  const result = await client.exec({
    query,
    abort_signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
  });
  let output = '';
  const decoder = new TextDecoder();
  for await (const chunk of result.stream) {
    if (typeof chunk === 'string') {
      output += chunk;
    } else if (chunk instanceof Uint8Array) {
      output += decoder.decode(chunk, { stream: true });
    } else {
      return null;
    }
    if (output.length > maxLength) return null;
  }
  output += decoder.decode();
  return output;
}

async function readGrantLines(
  client: BudgetProjectionClickHousePostureClient,
  query: string,
): Promise<string[] | null> {
  const output = await readExecText(client, query, 32_768);
  if (output === null || output.includes('\u0000')) return null;
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function exactRoleState(
  identityValue: NonNullable<Awaited<ReturnType<typeof identity>>>,
  expectedRole: string,
): boolean {
  return [identityValue.currentRoles, identityValue.enabledRoles, identityValue.defaultRoles].every(
    (roles) => roles.length === 1 && roles[0] === expectedRole,
  );
}

/** Attest the exact active role closure and its grants on ClickHouse 24.8+. */
export async function attestBudgetProjectionClickHouse(
  projector: BudgetProjectionClickHousePostureClient,
  general: BudgetProjectionClickHousePostureClient,
  metadata: BudgetProjectionClickHouseAttestationMetadata,
): Promise<BudgetProjectionClickHousePostureReason | null> {
  const [projectorIdentity, generalIdentity] = await Promise.all([
    identity(projector),
    identity(general),
  ]);
  if (!projectorIdentity || !generalIdentity) return 'invalid_attestation';
  if (
    projectorIdentity.username !== metadata.expectedProjectorUsername ||
    generalIdentity.username !== metadata.expectedGeneralUsername
  ) {
    return 'identity_mismatch';
  }
  if (
    projectorIdentity.database !== metadata.database ||
    generalIdentity.database !== metadata.database
  ) {
    return 'target_mismatch';
  }
  if (projectorIdentity.username === generalIdentity.username) {
    return 'identity_mismatch';
  }
  if (!exactRoleState(projectorIdentity, metadata.expectedProjectorRole)) {
    return 'projector_role_contract_invalid';
  }
  if (!exactRoleState(generalIdentity, metadata.expectedGeneralRole)) {
    return 'general_role_contract_invalid';
  }

  const expectedGrants = expectedAuthoritativeBudgetClickHouseGrants({
    database: metadata.database,
    generalRole: metadata.expectedGeneralRole,
    generalUsername: metadata.expectedGeneralUsername,
    projectorRole: metadata.expectedProjectorRole,
    projectorUsername: metadata.expectedProjectorUsername,
  });

  const [projectorDirectGrants, generalDirectGrants] = await Promise.all([
    readGrantLines(projector, 'SHOW GRANTS'),
    readGrantLines(general, 'SHOW GRANTS'),
  ]);
  if (!projectorDirectGrants || !generalDirectGrants) return 'invalid_attestation';
  if (!exactGrantLines(projectorDirectGrants, expectedGrants.projectorDirect)) {
    return 'projector_role_contract_invalid';
  }
  if (!exactGrantLines(generalDirectGrants, expectedGrants.generalDirect)) {
    return 'general_role_contract_invalid';
  }

  // The user's grant set must be exactly one fixed role, and the fixed role
  // must have exactly the grants below. This is equivalent to an exact
  // effective-grant expansion while remaining compatible with ClickHouse 24.8,
  // which does not implement SHOW GRANTS FINAL.
  const [projectorRoleGrants, generalRoleGrants] = await Promise.all([
    readGrantLines(
      projector,
      `SHOW GRANTS FOR ${quoteClickHouseIdentifier(metadata.expectedProjectorRole)}`,
    ),
    readGrantLines(
      general,
      `SHOW GRANTS FOR ${quoteClickHouseIdentifier(metadata.expectedGeneralRole)}`,
    ),
  ]);
  if (!projectorRoleGrants || !generalRoleGrants) return 'invalid_attestation';
  if (!exactGrantLines(projectorRoleGrants, expectedGrants.projectorRole)) {
    if (!expectedGrants.projectorRole.every((grant) => projectorRoleGrants.includes(grant))) {
      return 'projector_grant_missing';
    }
    return 'projector_effective_grants_mismatch';
  }
  if (!exactGrantLines(generalRoleGrants, expectedGrants.generalRole)) {
    if (!generalRoleGrants.includes(expectedGrants.generalRole[0]!)) {
      return 'general_read_grant_missing';
    }
    const legacyGrant = generalRoleGrants.find((grant) =>
      grant.includes(` ON ${metadata.database}.cost_events TO `),
    );
    if (!legacyGrant?.includes('INSERT')) {
      return 'legacy_ingest_grant_missing';
    }
    if (!legacyGrant.includes('ALTER UPDATE(cost_usd, pricing_status)')) {
      return 'legacy_backfill_grant_missing';
    }
    return 'general_effective_grants_mismatch';
  }

  return null;
}

function configFailureReason(
  error: BudgetProjectionClickHouseConfigError,
): BudgetProjectionClickHousePostureReason {
  if (error.code === 'missing_url') return 'credential_missing';
  if (error.code === 'credential_reuse' || error.code === 'fallback_forbidden') {
    return 'credential_isolation_failed';
  }
  if (error.code === 'target_mismatch') return 'target_mismatch';
  if (error.code === 'insecure_transport') return 'credential_invalid';
  return 'credential_invalid';
}

async function inspectPosture(): Promise<BudgetProjectionClickHousePosture> {
  let metadata: ReturnType<typeof getBudgetProjectionClickHouseClientMetadata>;
  let projector: ClickHouseClient;
  try {
    metadata = getBudgetProjectionClickHouseClientMetadata();
    projector = getBudgetProjectionClickHouseClient();
  } catch (error) {
    return {
      ready: false,
      reason:
        error instanceof BudgetProjectionClickHouseConfigError
          ? configFailureReason(error)
          : 'credential_invalid',
      attested: false,
      credential_source: null,
    };
  }

  if (env.NODE_ENV !== 'production') {
    return {
      ready: true,
      reason: null,
      attested: false,
      credential_source: metadata.source,
    };
  }

  try {
    const reason = await attestBudgetProjectionClickHouse(
      projector as unknown as BudgetProjectionClickHousePostureClient,
      generalClickHouse as unknown as BudgetProjectionClickHousePostureClient,
      metadata,
    );
    if (reason !== null) {
      return { ready: false, reason, attested: false, credential_source: null };
    }
  } catch {
    return {
      ready: false,
      reason: 'attestation_query_failed',
      attested: false,
      credential_source: null,
    };
  }

  return {
    ready: true,
    reason: null,
    attested: true,
    credential_source: metadata.source,
  };
}

interface PostureCache {
  expiresAt: number;
  promise: Promise<BudgetProjectionClickHousePosture>;
}

let postureCache: PostureCache | undefined;

export function getBudgetProjectionClickHousePosture(): Promise<BudgetProjectionClickHousePosture> {
  const now = Date.now();
  if (postureCache && now < postureCache.expiresAt) return postureCache.promise;

  const promise = inspectPosture();
  const next: PostureCache = {
    expiresAt: now + BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS,
    promise,
  };
  postureCache = next;
  void promise.then(
    (posture) => {
      // Repairs converge on the next request; only a successful attestation is
      // reused, and then for at most the bounded drift window above.
      if (!posture.ready && postureCache === next) postureCache = undefined;
    },
    () => {
      if (postureCache === next) postureCache = undefined;
    },
  );
  return promise;
}

export class BudgetProjectionClickHouseNotReadyError extends Error {
  readonly reason: BudgetProjectionClickHousePostureReason;
  readonly status = 503 as const;
  readonly code = 'INTERNAL_ERROR' as const;

  constructor(reason: BudgetProjectionClickHousePostureReason) {
    super(`authoritative budget projection ClickHouse posture is not ready (${reason})`);
    this.name = 'BudgetProjectionClickHouseNotReadyError';
    this.reason = reason;
  }
}

export async function assertBudgetProjectionClickHouseReady(): Promise<void> {
  const posture = await getBudgetProjectionClickHousePosture();
  if (!posture.ready) throw new BudgetProjectionClickHouseNotReadyError(posture.reason);
}

/**
 * Production boot gate. Projection must drain already-committed outbox rows
 * while new reservations are disabled, so its isolated writer is required
 * independently of the reservation feature flag.
 */
export async function assertBudgetProjectionClickHouseReadyForProduction(): Promise<void> {
  if (env.NODE_ENV !== 'production') return;
  await assertBudgetProjectionClickHouseReady();
}

/** Sole default projector path; explicit test clients continue to bypass global posture. */
export async function getReadyBudgetProjectionClickHouseClient(): Promise<ClickHouseClient> {
  await assertBudgetProjectionClickHouseReady();
  return getBudgetProjectionClickHouseClient();
}

export function _resetBudgetProjectionClickHousePostureForTests(): void {
  postureCache = undefined;
}
