export const LOCAL_BUDGET_PROJECTION_CLICKHOUSE_FALLBACK_ENV =
  'ALLOW_BUDGET_PROJECTION_CLICKHOUSE_URL_FALLBACK' as const;
export const BUDGET_PROJECTION_CLICKHOUSE_ROLE = 'pylva_authoritative_budget_projector' as const;
export const GENERAL_CLICKHOUSE_APP_ROLE = 'pylva_general_app_runtime' as const;
/** Bound privilege-drift exposure without adding per-event attestation traffic. */
export const BUDGET_PROJECTION_CLICKHOUSE_ATTESTATION_TTL_MS = 5_000 as const;

export type BudgetProjectionClickHouseConfigErrorCode =
  | 'credential_reuse'
  | 'fallback_forbidden'
  | 'insecure_transport'
  | 'invalid_url'
  | 'missing_url'
  | 'target_mismatch';

export class BudgetProjectionClickHouseConfigError extends Error {
  readonly code: BudgetProjectionClickHouseConfigErrorCode;

  constructor(code: BudgetProjectionClickHouseConfigErrorCode, message: string) {
    super(message);
    this.name = 'BudgetProjectionClickHouseConfigError';
    this.code = code;
  }
}

export interface BudgetProjectionClickHouseConfig {
  connectionUrl: string;
  database: string;
  expectedGeneralUsername: string;
  expectedProjectorUsername: string;
  source: 'dedicated' | 'local_ci_fallback';
}

export interface ClickHousePrincipal {
  database: string;
  hostname: string;
  origin: string;
  passwordPresent: boolean;
  protocol: 'http:' | 'https:';
  username: string;
}

export interface BudgetProjectionClickHouseResolutionOptions {
  /** Test harness only: the production CLI never enables this escape hatch. */
  allowInsecureLoopbackForTests?: boolean;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function decodeUrlPart(value: string, variableName: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BudgetProjectionClickHouseConfigError(
      'invalid_url',
      `${variableName} contains invalid percent encoding`,
    );
  }
}

/** Parse only non-secret identity/target fields from a ClickHouse URL. */
export function parseClickHousePrincipal(
  connectionUrl: string,
  variableName = 'BUDGET_PROJECTION_CLICKHOUSE_URL',
): ClickHousePrincipal {
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new BudgetProjectionClickHouseConfigError(
      'invalid_url',
      `${variableName} must be a valid ClickHouse HTTP URL`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BudgetProjectionClickHouseConfigError(
      'invalid_url',
      `${variableName} must use http:// or https://`,
    );
  }

  const decodedPath = decodeUrlPart(parsed.pathname.replace(/^\//, ''), variableName);
  if (decodedPath.includes('/')) {
    throw new BudgetProjectionClickHouseConfigError(
      'invalid_url',
      `${variableName} must identify at most one ClickHouse database`,
    );
  }

  return {
    database: decodedPath || 'default',
    hostname: parsed.hostname.toLowerCase(),
    origin: parsed.origin.toLowerCase(),
    passwordPresent: parsed.password.length > 0,
    protocol: parsed.protocol as 'http:' | 'https:',
    username: decodeUrlPart(parsed.username, variableName) || 'default',
  };
}

function sameClickHouseTarget(left: ClickHousePrincipal, right: ClickHousePrincipal): boolean {
  return left.origin === right.origin && left.database === right.database;
}

/**
 * Resolve the sole authoritative projector credential. Production has no
 * compatibility path: it must use a password-bearing, non-default principal
 * distinct from the general reader/legacy-ingest principal on the same target.
 */
export function resolveBudgetProjectionClickHouseConfig(
  source: Record<string, string | undefined>,
  options: BudgetProjectionClickHouseResolutionOptions = {},
): BudgetProjectionClickHouseConfig {
  const production = source['NODE_ENV'] === 'production';
  const allowLocalFallback = source[LOCAL_BUDGET_PROJECTION_CLICKHOUSE_FALLBACK_ENV] === 'true';
  const generalUrl = nonBlank(source['CLICKHOUSE_URL']);
  const dedicatedUrl = nonBlank(source['BUDGET_PROJECTION_CLICKHOUSE_URL']);

  if (!generalUrl) {
    throw new BudgetProjectionClickHouseConfigError(
      'missing_url',
      'CLICKHOUSE_URL is required to attest the general ClickHouse principal',
    );
  }
  if (production && allowLocalFallback) {
    throw new BudgetProjectionClickHouseConfigError(
      'fallback_forbidden',
      `${LOCAL_BUDGET_PROJECTION_CLICKHOUSE_FALLBACK_ENV} is forbidden in production`,
    );
  }

  const connectionUrl =
    dedicatedUrl ?? (!production && allowLocalFallback ? generalUrl : undefined);
  if (!connectionUrl) {
    throw new BudgetProjectionClickHouseConfigError(
      'missing_url',
      production
        ? 'BUDGET_PROJECTION_CLICKHOUSE_URL is required in production'
        : `BUDGET_PROJECTION_CLICKHOUSE_URL is required; local/CI may explicitly set ${LOCAL_BUDGET_PROJECTION_CLICKHOUSE_FALLBACK_ENV}=true`,
    );
  }

  const general = parseClickHousePrincipal(generalUrl, 'CLICKHOUSE_URL');
  const projector = parseClickHousePrincipal(connectionUrl, 'BUDGET_PROJECTION_CLICKHOUSE_URL');

  if (production && (general.protocol !== 'https:' || projector.protocol !== 'https:')) {
    const loopback = new Set(['127.0.0.1', '::1', 'localhost']);
    const explicitTestBypass =
      options.allowInsecureLoopbackForTests === true &&
      loopback.has(general.hostname) &&
      loopback.has(projector.hostname);
    if (!explicitTestBypass) {
      throw new BudgetProjectionClickHouseConfigError(
        'insecure_transport',
        'production ClickHouse application credentials must use https:// transport',
      );
    }
  }

  if (production && !sameClickHouseTarget(projector, general)) {
    throw new BudgetProjectionClickHouseConfigError(
      'target_mismatch',
      'the authoritative projector and general ClickHouse principals must address the same database target',
    );
  }

  const principalReused = projector.username === general.username;
  if (principalReused && (production || !allowLocalFallback)) {
    throw new BudgetProjectionClickHouseConfigError(
      'credential_reuse',
      'the authoritative projector must use a principal distinct from CLICKHOUSE_URL',
    );
  }

  if (
    production &&
    (general.username === 'default' ||
      !general.passwordPresent ||
      projector.username === 'default' ||
      !projector.passwordPresent)
  ) {
    throw new BudgetProjectionClickHouseConfigError(
      'invalid_url',
      'production ClickHouse URLs must contain dedicated usernames and credentials',
    );
  }

  return {
    connectionUrl,
    database: projector.database,
    expectedGeneralUsername: general.username,
    expectedProjectorUsername: projector.username,
    source: principalReused ? 'local_ci_fallback' : 'dedicated',
  };
}
