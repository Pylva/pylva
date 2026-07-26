import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import postgres, { type Sql } from 'postgres';
import { CI_POSTGRES_MIGRATION_ROLE } from '../../scripts/ci/bootstrap-authoritative-budget-migration-role.js';

const DEFAULT_DATABASE_URL = 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

export const TEST_DATABASE_ADMIN_URL_ENV = 'PYLVA_TEST_DATABASE_ADMIN_URL' as const;
export const FRESH_INSTALL_SCRATCH_BOOTSTRAP_GUIDANCE =
  'Set CI_POSTGRES_ADMIN_URL and MIGRATION_DATABASE_URL, run `pnpm exec tsx scripts/ci/bootstrap-authoritative-budget-migration-role.ts`, then set PYLVA_TEST_DATABASE_ADMIN_URL to that scoped migration principal.' as const;

export interface ScratchDb {
  name: string;
  url: string;
  sql: Sql;
  drop(): Promise<void>;
}

interface FreshInstallScratchPosture {
  current_user_name: string;
  session_user_name: string;
  can_login: boolean;
  inherits_privileges: boolean;
  can_create_database: boolean;
  can_create_role: boolean;
  is_superuser: boolean;
  bypasses_rls: boolean;
  can_replicate: boolean;
  owns_current_database: boolean;
}

function databaseUrlForName(baseUrl: string, name: string): string {
  const nextUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, `/${name}$1`);
  if (nextUrl === baseUrl) {
    throw new Error('Unable to replace database name in DATABASE_URL');
  }
  return nextUrl;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Scratch databases need an identity that can CREATE/DROP DATABASE and apply
 * migrations. CI's general application login deliberately cannot do that, so
 * tests may supply a separate, test-only administrative URL.
 */
export function resolveScratchDatabaseAdminUrl(source: NodeJS.ProcessEnv = process.env): string {
  return (
    nonBlank(source[TEST_DATABASE_ADMIN_URL_ENV]) ??
    nonBlank(source['DATABASE_URL']) ??
    DEFAULT_DATABASE_URL
  );
}

export async function createScratchDb(opts?: { prefix?: string }): Promise<ScratchDb> {
  const baseUrl = resolveScratchDatabaseAdminUrl();
  const prefix = opts?.prefix ?? 'pylva_scratch';
  const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '_');
  const name = `${safePrefix}_${randomBytes(6).toString('hex')}`;
  const url = databaseUrlForName(baseUrl, name);
  const managementSql = postgres(baseUrl, { max: 1, onnotice: () => undefined });

  try {
    await managementSql.unsafe(`CREATE DATABASE ${quoteIdentifier(name)}`);
  } finally {
    await managementSql.end();
  }

  const sql = postgres(url, { max: 1, onnotice: () => undefined });

  return {
    name,
    url,
    sql,
    drop: async (): Promise<void> => {
      try {
        await sql.end();
      } catch {
        // drop() is intentionally idempotent for try/finally cleanup paths.
      }

      const dropSql = postgres(baseUrl, { max: 1, onnotice: () => undefined });
      try {
        await dropSql.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
      } finally {
        await dropSql.end();
      }
    },
  };
}

/**
 * Create a full-manifest scratch database under the one fixed, scoped
 * migration identity used across the PostgreSQL cluster.
 *
 * Migration 052 creates cluster-global roles whose exact creator-admin edge is
 * bound to that identity. A unique role per test would make the next database
 * fail the role-graph contract, so cleanup drops only the disposable database
 * and deliberately preserves the fixed migration principal.
 */
export async function createFreshInstallScratchDb(opts?: {
  prefix?: string;
}): Promise<ScratchDb> {
  const scratch = await createScratchDb(opts);
  try {
    const rows = (await scratch.sql.unsafe(`
      SELECT current_user::TEXT AS current_user_name,
             session_user::TEXT AS session_user_name,
             role.rolcanlogin AS can_login,
             role.rolinherit AS inherits_privileges,
             role.rolcreatedb AS can_create_database,
             role.rolcreaterole AS can_create_role,
             role.rolsuper AS is_superuser,
             role.rolbypassrls AS bypasses_rls,
             role.rolreplication AS can_replicate,
             (database.datdba = role.oid) AS owns_current_database
      FROM pg_catalog.pg_roles AS role
      JOIN pg_catalog.pg_database AS database
        ON database.datname = current_database()
      WHERE role.rolname = current_user
    `)) as unknown as FreshInstallScratchPosture[];
    const posture = rows[0];
    const safe =
      rows.length === 1 &&
      posture !== undefined &&
      posture.current_user_name === CI_POSTGRES_MIGRATION_ROLE &&
      posture.session_user_name === CI_POSTGRES_MIGRATION_ROLE &&
      posture.can_login === true &&
      posture.inherits_privileges === true &&
      posture.can_create_database === true &&
      posture.can_create_role === true &&
      posture.is_superuser === false &&
      posture.bypasses_rls === false &&
      posture.can_replicate === false &&
      posture.owns_current_database === true;
    if (!safe) {
      throw new Error(
        `Fresh-install scratch database is not owned by the fixed scoped migration principal ${CI_POSTGRES_MIGRATION_ROLE}. ${FRESH_INSTALL_SCRATCH_BOOTSTRAP_GUIDANCE}`,
      );
    }
    return scratch;
  } catch (error) {
    await scratch.drop();
    throw error;
  }
}

export async function applyMigrationsThrough(
  scratch: ScratchDb,
  lastPrefix: string,
): Promise<string[]> {
  const migrationsDir = path.resolve('db/migrations');
  const maxPrefix = Number.parseInt(lastPrefix.slice(0, 3), 10);
  const filenames = (await fs.readdir(migrationsDir))
    .filter((filename) => filename.endsWith('.sql'))
    .filter((filename) => {
      const prefix = Number.parseInt(filename.slice(0, 3), 10);
      return Number.isFinite(prefix) && prefix <= maxPrefix;
    })
    .sort();

  for (const filename of filenames) {
    const content = await fs.readFile(path.join(migrationsDir, filename), 'utf8');
    await scratch.sql.begin((sql) => sql.unsafe(content));
  }

  return filenames;
}
