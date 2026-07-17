export const LOCAL_BUDGET_CONTROL_FALLBACK_ENV =
  'ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK' as const;

export type BudgetControlDatabaseConfigErrorCode =
  | 'credential_exposure'
  | 'credential_reuse'
  | 'invalid_url'
  | 'missing_url';

export class BudgetControlDatabaseConfigError extends Error {
  readonly code: BudgetControlDatabaseConfigErrorCode;

  constructor(code: BudgetControlDatabaseConfigErrorCode, message: string) {
    super(message);
    this.name = 'BudgetControlDatabaseConfigError';
    this.code = code;
  }
}

export interface BudgetControlDatabaseConfig {
  databaseUrl: string;
  expectedUsername: string;
  runtimeUserSecretArn?: string;
  source: 'dedicated' | 'local_ci_fallback';
}

interface DatabasePrincipal {
  database: string;
  host: string;
  port: string;
  username: string;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new BudgetControlDatabaseConfigError(
      'invalid_url',
      'BUDGET_CONTROL_DATABASE_URL contains invalid percent encoding',
    );
  }
}

export function parseDatabasePrincipal(databaseUrl: string): DatabasePrincipal {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new BudgetControlDatabaseConfigError(
      'invalid_url',
      'BUDGET_CONTROL_DATABASE_URL must be a valid PostgreSQL URL',
    );
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new BudgetControlDatabaseConfigError(
      'invalid_url',
      'BUDGET_CONTROL_DATABASE_URL must use postgres:// or postgresql://',
    );
  }

  const username = decodeUrlPart(parsed.username);
  if (!username) {
    throw new BudgetControlDatabaseConfigError(
      'invalid_url',
      'BUDGET_CONTROL_DATABASE_URL must identify a dedicated login role',
    );
  }

  return {
    database: decodeUrlPart(parsed.pathname.replace(/^\//, '')),
    host: parsed.hostname.toLowerCase(),
    port: parsed.port || '5432',
    username,
  };
}

export function sameDatabasePrincipal(leftUrl: string, rightUrl: string): boolean {
  const left = parseDatabasePrincipal(leftUrl);
  const right = parseDatabasePrincipal(rightUrl);
  // The general, migration, and budget-control URLs all address the same
  // authoritative data plane. Hostnames are not a trustworthy identity
  // boundary: one PostgreSQL cluster may be reached through writer, proxy, or
  // multi-host aliases. Conservatively require distinct role names.
  return left.username === right.username;
}

function assertNoSecretReuse(source: Record<string, string | undefined>): void {
  const budgetSecret = nonBlank(source['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN']);
  if (!budgetSecret) return;

  const privilegedSecrets = [
    source['DB_MASTER_USER_SECRET_ARN'],
    source['DB_RUNTIME_USER_SECRET_ARN'],
    source['MIGRATION_DB_MASTER_USER_SECRET_ARN'],
    source['MIGRATION_DB_RUNTIME_USER_SECRET_ARN'],
    source['MIGRATION_DATABASE_SECRET_ARN'],
  ].map(nonBlank);
  if (privilegedSecrets.includes(budgetSecret)) {
    throw new BudgetControlDatabaseConfigError(
      'credential_reuse',
      'budget-control runtime credentials must not reuse a general or migration database secret',
    );
  }
}

function assertNoProductionMigrationCredentialExposure(
  source: Record<string, string | undefined>,
): void {
  const migrationCredentialNames = [
    'MIGRATION_DATABASE_URL',
    'MIGRATION_DB_HOST',
    'MIGRATION_DB_PORT',
    'MIGRATION_DB_NAME',
    'MIGRATION_DB_SSLMODE',
    'MIGRATION_DB_USERNAME',
    'MIGRATION_DB_PASSWORD',
    'MIGRATION_DB_MASTER_USER_SECRET_ARN',
    'MIGRATION_DB_RUNTIME_USER_SECRET_ARN',
    'MIGRATION_DATABASE_SECRET_ARN',
  ] as const;

  if (migrationCredentialNames.some((name) => nonBlank(source[name]) !== undefined)) {
    throw new BudgetControlDatabaseConfigError(
      'credential_exposure',
      'migration database credentials must never be injected into the Next.js runtime',
    );
  }
}

/**
 * Resolve the dedicated authoritative-control connection without ever
 * silently falling back in production. PostgreSQL roles are cluster-wide, so
 * principal identity deliberately ignores passwords, database paths, and host
 * aliases: none of them can disguise reuse of the same cluster-wide login.
 */
export function resolveBudgetControlDatabaseConfig(
  source: Record<string, string | undefined>,
): BudgetControlDatabaseConfig {
  const production = source['NODE_ENV'] === 'production';
  const allowLocalFallback = source[LOCAL_BUDGET_CONTROL_FALLBACK_ENV] === 'true';
  const dedicatedUrl = nonBlank(source['BUDGET_CONTROL_DATABASE_URL']);
  const generalUrl = nonBlank(source['DATABASE_URL']);
  const migrationUrl = nonBlank(source['MIGRATION_DATABASE_URL']);

  if (production) assertNoProductionMigrationCredentialExposure(source);

  const databaseUrl = dedicatedUrl ?? (!production && allowLocalFallback ? generalUrl : undefined);
  if (!databaseUrl) {
    throw new BudgetControlDatabaseConfigError(
      'missing_url',
      production
        ? 'BUDGET_CONTROL_DATABASE_URL is required in production'
        : `BUDGET_CONTROL_DATABASE_URL is required; local/CI may explicitly set ${LOCAL_BUDGET_CONTROL_FALLBACK_ENV}=true`,
    );
  }

  const principal = parseDatabasePrincipal(databaseUrl);

  if (generalUrl && sameDatabasePrincipal(databaseUrl, generalUrl)) {
    if (production || !allowLocalFallback) {
      throw new BudgetControlDatabaseConfigError(
        'credential_reuse',
        'BUDGET_CONTROL_DATABASE_URL must use a login distinct from DATABASE_URL',
      );
    }
  }
  if (migrationUrl && sameDatabasePrincipal(databaseUrl, migrationUrl)) {
    throw new BudgetControlDatabaseConfigError(
      'credential_reuse',
      'BUDGET_CONTROL_DATABASE_URL must use a login distinct from MIGRATION_DATABASE_URL',
    );
  }

  assertNoSecretReuse(source);
  const runtimeUserSecretArn = nonBlank(source['BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN']);

  return {
    databaseUrl,
    expectedUsername: principal.username,
    ...(runtimeUserSecretArn === undefined ? {} : { runtimeUserSecretArn }),
    source: dedicatedUrl === undefined ? 'local_ci_fallback' : 'dedicated',
  };
}
