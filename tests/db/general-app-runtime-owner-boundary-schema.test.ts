import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../db/migrations/054_general_app_runtime_owner_boundary.sql', import.meta.url),
  'utf8',
);

const LEGACY_TABLES = [
  'alert_history',
  'anomaly_events',
  'api_key_vault',
  'api_keys',
  'audit_log',
  'builder_alert_config',
  'builder_feature_flags',
  'builders',
  'cost_sources',
  'custom_pricing',
  'custom_rule_requests',
  'customer_pricing',
  'customers',
  'feature_flag_overrides',
  'invites',
  'invoice_idempotency',
  'invoices',
  'llm_pricing',
  'portal_access_grants',
  'portal_configs',
  'portal_domains',
  'portal_links',
  'portal_sessions',
  'pricing_onboarding_tasks',
  'pricing_sync_log',
  'rule_alert_channels',
  'rule_events',
  'rules',
  'stripe_connect',
  'stripe_connect_event_log',
  'user_builder_memberships',
  'users',
  'webhook_configs',
  'webhook_dlq',
] as const;

const AUTHORITY_TABLES = [
  'budget_account_opening_evidence',
  'budget_accounts',
  'budget_control_cutovers',
  'budget_cost_event_outbox',
  'budget_reservation_allocations',
  'budget_reservation_transitions',
  'budget_reservations',
  'budget_rule_revisions',
  'budget_usage_ledger',
] as const;

const FROZEN_MIGRATIONS = {
  '050_authoritative_budget_control_ledger.sql':
    '3bd8b69ef1b09814e6cc0645b2eb188504fc84b4e15abbe5e42ddf704619218e',
  '051_authoritative_budget_control_runtime.sql':
    '3fabbc1236e562eddd1b83e4c8826abfb61d0eca73b8e4773b10d94599055af8',
  '052_authoritative_budget_control_runtime_roles.sql':
    '3cc7efe258ceb49e9fd56789c3fdb9a0f6cd76e990d5f5681ecc24cde4172be6',
  '053_legacy_catalog_owner_rls_compatibility.sql':
    'ba598fab2d79316926ebce3e853c61a1408dae14cd4bb40a0a572f0a90bb431f',
} as const;

function ownershipArray(): string[] {
  const block = migration.match(
    /FOREACH relation_name IN ARRAY ARRAY\[([\s\S]*?)\]::pg_catalog\.name\[\]/u,
  )?.[1];
  expect(block).toBeDefined();
  return [...block!.matchAll(/'([^']+)'/gu)].map((match) => match[1]!).sort();
}

describe('general-app runtime owner-boundary migration 054', () => {
  it('owns an explicit and exhaustive legacy table allowlist', () => {
    expect(ownershipArray()).toEqual([...LEGACY_TABLES].sort());
    expect(migration).not.toMatch(/ALTER (?:TABLE|SEQUENCE|FUNCTION).*\bALL\b/iu);
    expect(migration).not.toMatch(/ALTER TABLE public\.schema_migrations OWNER/iu);
    expect(migration).not.toMatch(/ALTER TABLE public\._048_api_keys_scope_backup OWNER/iu);
    for (const table of AUTHORITY_TABLES) {
      expect(ownershipArray()).not.toContain(table);
      expect(migration).not.toMatch(new RegExp(`ALTER TABLE public\\.${table} OWNER`, 'u'));
    }
  });

  it('keeps the fixed owner non-login, non-privileged, and ownership-bounded', () => {
    expect(migration).toMatch(
      /CREATE ROLE pylva_general_app_runtime\s+NOLOGIN\s+NOSUPERUSER\s+NOCREATEDB\s+NOCREATEROLE\s+NOINHERIT\s+NOREPLICATION\s+NOBYPASSRLS;/u,
    );
    expect(migration).toContain('database.datdba = owner_oid');
    expect(migration).toContain('namespace.nspowner = owner_oid');
    expect(migration).toContain('default_acl.defaclrole = owner_oid');
    expect(migration).toContain('privilege.grantee = owner_oid');
    expect(migration).toContain('general-app runtime relation ownership contract is incomplete');
    expect(migration).toContain("'webhook_configs_with_grace', 'v'::\"char\"");
    for (const sequence of ['api_key_vault_id_seq', 'audit_log_id_seq', 'llm_pricing_id_seq']) {
      expect(migration).toContain(sequence);
    }
  });

  it('uses separate non-inheriting migrator edges and one tightly bounded login edge', () => {
    expect(migration).toContain('WITH ADMIN FALSE, INHERIT FALSE, SET TRUE');
    expect(migration).toContain('(edge.admin_option AND NOT edge.set_option)');
    expect(migration).toContain('(NOT edge.admin_option AND edge.set_option)');
    expect(migration).toContain('NOT member_role.rolinherit');
    expect(migration).toContain('NOT edge.admin_option');
    expect(migration).toContain('edge.inherit_option');
    expect(migration).toContain('NOT edge.set_option');
    expect(migration).toContain('login_member_edge.roleid = member_role.oid');
    expect(migration).toContain('login_member_role.rolname = CURRENT_USER');
    expect(migration).toContain('login_member_edge.admin_option');
    expect(migration).toContain('NOT login_member_edge.inherit_option');
    expect(migration).toContain('NOT login_member_edge.set_option');
  });

  it('removes and attests table, sequence, column, and discovery-function authority access', () => {
    for (const table of AUTHORITY_TABLES) {
      expect(migration).toContain(table);
    }
    expect(migration).toContain('pg_catalog.aclexplode(attribute.attacl)');
    expect(migration).toContain('pg_catalog.has_column_privilege(');
    expect(migration).toContain('pg_catalog.has_table_privilege(');
    expect(migration).toContain('pg_catalog.has_sequence_privilege(');
    expect(migration).toContain('pylva_budget_authority_order_seq');
    expect(migration).toContain('pylva_budget_projection_actionable_builders');
    expect(migration).toContain('pylva_budget_expiry_actionable_builders');
    expect(migration).toContain(
      'general-app runtime migration-ledger privilege is not SELECT-only',
    );
  });

  it('captures and validates the historical partition calendar timezone', () => {
    expect(migration).toContain('SET TimeZone FROM CURRENT');
    expect(migration).toContain('SET search_path = pg_catalog');
    expect(migration).toContain("partition_row.partition_name !~ '^audit_log_y");
    expect(migration).toContain('partition_row.partition_bound IS DISTINCT FROM expected_bound');
    expect(migration).toContain('rerun migration 054 using the historical partition TimeZone');
    expect(migration).toContain('existing_owner');
    expect(migration).toContain('existing_kind');
    expect(migration).toContain('existing_is_partition');
    expect(migration).toContain('existing_bound IS DISTINCT FROM expected_bound');
    expect(migration).toContain('pg_catalog.pg_advisory_xact_lock(');
    expect(migration).toContain("parent.relname = 'audit_log'");
    expect(migration).toContain("p_month_start > (utc_current_month + INTERVAL '12 months')");
    expect(migration).not.toContain("SET TimeZone = 'UTC'");
  });

  it('leaves migrations 050 through 053 byte-identical', () => {
    for (const [filename, expectedHash] of Object.entries(FROZEN_MIGRATIONS)) {
      const source = readFileSync(new URL(`../../db/migrations/${filename}`, import.meta.url));
      expect(createHash('sha256').update(source).digest('hex'), filename).toBe(expectedHash);
    }
  });
});
