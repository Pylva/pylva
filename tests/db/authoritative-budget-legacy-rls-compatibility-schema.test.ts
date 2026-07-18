import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../db/migrations/053_legacy_catalog_owner_rls_compatibility.sql', import.meta.url),
  'utf8',
);

const LEGACY_OWNER_CATALOGS = ['builders', 'cost_sources', 'custom_pricing', 'rules'] as const;
const AUTHORITATIVE_TABLES = [
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

describe('legacy catalog owner RLS compatibility migration 053', () => {
  it('keeps RLS enabled while removing FORCE from exactly four legacy catalogs', () => {
    const enabledTables = [
      ...migration.matchAll(/ALTER TABLE public\.(\w+) ENABLE ROW LEVEL SECURITY;/g),
    ]
      .map((match) => match[1])
      .sort();
    const notForcedTables = [
      ...migration.matchAll(/ALTER TABLE public\.(\w+) NO FORCE ROW LEVEL SECURITY;/g),
    ]
      .map((match) => match[1])
      .sort();

    expect(enabledTables).toEqual([...LEGACY_OWNER_CATALOGS].sort());
    expect(notForcedTables).toEqual([...LEGACY_OWNER_CATALOGS].sort());
    expect(migration).not.toContain('DISABLE ROW LEVEL SECURITY');
  });

  it('does not alter the FORCE posture of any authoritative/control table', () => {
    for (const table of AUTHORITATIVE_TABLES) {
      expect(migration).not.toMatch(new RegExp(`ALTER TABLE public\\.${table}\\b`));
    }
  });

  it('records the table-owner bootstrap rationale and the non-owner runtime boundary', () => {
    expect(migration).toContain('Migration 046');
    expect(migration).toContain('authentication/bootstrap');
    expect(migration).toContain('NOBYPASSRLS non-owner');
    expect(migration).toContain('nine authoritative/control tables remain');
  });
});
