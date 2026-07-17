import {
  BUDGET_PROJECTION_CLICKHOUSE_ROLE,
  GENERAL_CLICKHOUSE_APP_ROLE,
} from './clickhouse-config.js';

export interface AuthoritativeBudgetClickHouseRbacIdentity {
  database: string;
  generalRole?: string;
  generalUsername: string;
  projectorRole?: string;
  projectorUsername: string;
}

export interface AuthoritativeBudgetClickHouseGrantContract {
  generalDirect: string[];
  generalRole: string[];
  projectorDirect: string[];
  projectorRole: string[];
}

export function quoteClickHouseIdentifier(value: string): string {
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('ClickHouse RBAC identifiers must be non-empty and contain no control bytes');
  }
  return `"${value.replaceAll('"', '""')}"`;
}

export function canonicalClickHouseIdentifier(value: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) return value;
  return `\`${value.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``;
}

function resolvedIdentity(identity: AuthoritativeBudgetClickHouseRbacIdentity) {
  return {
    ...identity,
    generalRole: identity.generalRole ?? GENERAL_CLICKHOUSE_APP_ROLE,
    projectorRole: identity.projectorRole ?? BUDGET_PROJECTION_CLICKHOUSE_ROLE,
  };
}

export function expectedAuthoritativeBudgetClickHouseGrants(
  identity: AuthoritativeBudgetClickHouseRbacIdentity,
): AuthoritativeBudgetClickHouseGrantContract {
  const resolved = resolvedIdentity(identity);
  const database = canonicalClickHouseIdentifier(resolved.database);
  const generalRole = canonicalClickHouseIdentifier(resolved.generalRole);
  const generalUser = canonicalClickHouseIdentifier(resolved.generalUsername);
  const projectorRole = canonicalClickHouseIdentifier(resolved.projectorRole);
  const projectorUser = canonicalClickHouseIdentifier(resolved.projectorUsername);
  return {
    projectorDirect: [`GRANT ${projectorRole} TO ${projectorUser}`],
    projectorRole: [`GRANT SELECT, INSERT ON ${database}.budget_cost_events TO ${projectorRole}`],
    generalDirect: [`GRANT ${generalRole} TO ${generalUser}`],
    generalRole: [
      `GRANT SELECT ON ${database}.* TO ${generalRole}`,
      `GRANT INSERT, ALTER UPDATE(cost_usd, pricing_status) ON ${database}.cost_events TO ${generalRole}`,
    ],
  };
}

/**
 * Remove the authoritative INSERT leaf from every non-projector principal.
 * If a principal owns a wider INSERT grant, ClickHouse records an exact
 * partial revoke and preserves its unrelated writes.
 */
export function authoritativeBudgetInsertRevoke(database: string, principal: string): string {
  return `REVOKE INSERT ON ${quoteClickHouseIdentifier(database)}."budget_cost_events" FROM ${quoteClickHouseIdentifier(principal)}`;
}

export function authoritativeBudgetInsertRevokeAllExcept(
  database: string,
  allowedPrincipals: readonly string[],
): string {
  if (allowedPrincipals.length === 0) {
    throw new Error('at least one authoritative writer principal must be retained');
  }
  return `REVOKE INSERT ON ${quoteClickHouseIdentifier(database)}."budget_cost_events" FROM ALL EXCEPT ${allowedPrincipals
    .map(quoteClickHouseIdentifier)
    .join(', ')}`;
}

/**
 * Idempotent least-privilege replacement plan. Passwords never enter SQL: the
 * two users must already exist from the deployment's secret-management path.
 */
export function buildAuthoritativeBudgetClickHouseRbacStatements(
  identity: AuthoritativeBudgetClickHouseRbacIdentity,
): string[] {
  const resolved = resolvedIdentity(identity);
  const database = quoteClickHouseIdentifier(resolved.database);
  const generalRole = quoteClickHouseIdentifier(resolved.generalRole);
  const generalUser = quoteClickHouseIdentifier(resolved.generalUsername);
  const projectorRole = quoteClickHouseIdentifier(resolved.projectorRole);
  const projectorUser = quoteClickHouseIdentifier(resolved.projectorUsername);

  if (resolved.generalUsername === resolved.projectorUsername) {
    throw new Error('general and projector ClickHouse users must be distinct');
  }
  if (resolved.generalRole === resolved.projectorRole) {
    throw new Error('general and projector ClickHouse roles must be distinct');
  }

  return [
    `CREATE ROLE IF NOT EXISTS ${projectorRole}`,
    `CREATE ROLE IF NOT EXISTS ${generalRole}`,
    `REVOKE ALL ON *.* FROM ${projectorRole}`,
    `REVOKE ALL FROM ${projectorRole}`,
    `REVOKE ALL ON *.* FROM ${generalRole}`,
    `REVOKE ALL FROM ${generalRole}`,
    `REVOKE ALL ON *.* FROM ${projectorUser}`,
    `REVOKE ALL FROM ${projectorUser}`,
    `REVOKE ALL ON *.* FROM ${generalUser}`,
    `REVOKE ALL FROM ${generalUser}`,
    `GRANT SELECT, INSERT ON ${database}."budget_cost_events" TO ${projectorRole}`,
    `GRANT SELECT ON ${database}.* TO ${generalRole}`,
    `GRANT INSERT ON ${database}."cost_events" TO ${generalRole}`,
    `GRANT ALTER UPDATE(cost_usd, pricing_status) ON ${database}."cost_events" TO ${generalRole}`,
    `GRANT ${projectorRole} TO ${projectorUser}`,
    `GRANT ${generalRole} TO ${generalUser}`,
    `SET DEFAULT ROLE ${projectorRole} TO ${projectorUser}`,
    `SET DEFAULT ROLE ${generalRole} TO ${generalUser}`,
  ];
}

export function exactGrantLines(actual: readonly string[], expected: readonly string[]): boolean {
  if (actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  return sortedActual.every((line, index) => line === sortedExpected[index]);
}
