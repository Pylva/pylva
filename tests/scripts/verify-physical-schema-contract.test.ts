import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_SCOPE_MIGRATIONS,
  parseVerifyPhysicalSchemaArgs,
  scopeValuesFromConstraintDefinition,
  verifyApiKeyScopeContract,
} from '../../scripts/verify-physical-schema-contract.js';

const migrations = API_KEY_SCOPE_MIGRATIONS.map((filename, index) => ({
  checksum: `checksum-${index}`,
  content: '',
  filename,
  phase:
    filename === '048_universal_api_key_scope.sql' ? ('post_roll' as const) : ('pre_roll' as const),
}));

function fakeClient({
  constraintDefinition = "CHECK ((scope = ANY (ARRAY['agent_sdk'::character varying, 'admin_api'::character varying, 'data_import'::character varying, 'universal'::character varying])))",
  constraintName = 'api_keys_scope_check',
  extraConstraints = [] as Array<{
    conname: string;
    convalidated: boolean;
    definition: string;
  }>,
  ledgerRows = migrations.map((migration) => ({
    checksum: migration.checksum,
    filename: migration.filename,
  })),
  scopeRows = [{ count: '3', scope: 'universal' }],
  validated = true,
}: {
  constraintDefinition?: string;
  constraintName?: string;
  extraConstraints?: Array<{
    conname: string;
    convalidated: boolean;
    definition: string;
  }>;
  ledgerRows?: Array<{ checksum: string; filename: string }>;
  scopeRows?: Array<{ count: string; scope: string }>;
  validated?: boolean;
} = {}) {
  return {
    unsafe: vi.fn(async (query: string) => {
      if (query.includes('FROM pg_constraint')) {
        return [
          {
            conname: constraintName,
            convalidated: validated,
            definition: constraintDefinition,
          },
          ...extraConstraints,
        ];
      }
      if (query.includes('FROM schema_migrations')) return ledgerRows;
      if (query.includes('FROM api_keys')) return scopeRows;
      throw new Error(`Unexpected query: ${query}`);
    }),
  };
}

describe('physical API-key schema contract', () => {
  it('parses the explicit contract argument', () => {
    expect(parseVerifyPhysicalSchemaArgs(['--contract', 'api_keys_scope', '--json'])).toEqual({
      contract: 'api_keys_scope',
      json: true,
    });
    expect(parseVerifyPhysicalSchemaArgs(['--', '--contract', 'api_keys_scope'])).toEqual({
      contract: 'api_keys_scope',
      json: false,
    });
    expect(() => parseVerifyPhysicalSchemaArgs([])).toThrow(/required/);
    expect(() => parseVerifyPhysicalSchemaArgs(['--contract', 'other'])).toThrow(/must be/);
  });

  it('extracts PostgreSQL CHECK literals without assuming formatting', () => {
    expect(
      scopeValuesFromConstraintDefinition(
        "CHECK ((scope = ANY (ARRAY['universal'::text, 'agent_sdk'::text, 'universal'::text])))",
      ),
    ).toEqual(['agent_sdk', 'universal']);
  });

  it('passes only when the physical constraint, ledger, and persisted values agree', async () => {
    const sql = fakeClient();
    const result = await verifyApiKeyScopeContract({
      migrations,
      sql,
    });

    expect(result.ok).toBe(true);
    expect(result.ledger).toEqual([
      { checksum_matches: true, filename: '041_rename_api_key_scopes.sql', present: true },
      { checksum_matches: true, filename: '048_universal_api_key_scope.sql', present: true },
    ]);
    expect(
      sql.unsafe.mock.calls
        .map(([query]) => String(query).trim())
        .every((query) => query.startsWith('SELECT')),
    ).toBe(true);
  });

  it('flags a named-only constraint, missing ledger checksum, and unexpected scope value', async () => {
    const result = await verifyApiKeyScopeContract({
      migrations,
      sql: fakeClient({
        constraintDefinition:
          "CHECK ((scope = ANY (ARRAY['agent_sdk'::text, 'admin_api'::text, 'data_import'::text])))",
        ledgerRows: [{ checksum: 'wrong', filename: '048_universal_api_key_scope.sql' }],
        extraConstraints: [
          {
            conname: 'api_keys_scope_legacy_check',
            convalidated: true,
            definition: "CHECK ((scope = 'legacy_unknown'))",
          },
        ],
        scopeRows: [
          { count: '1', scope: 'universal' },
          { count: '1', scope: 'legacy_unknown' },
        ],
      }),
    });

    expect(result.ok).toBe(false);
    expect(result.constraint_scope_values).not.toContain('universal');
    expect(result.ledger.map((row) => row.checksum_matches)).toEqual([false, false]);
    expect(result.unexpected_scope_values).toEqual(['legacy_unknown']);
    expect(result.unexpected_constraints).toEqual(['api_keys_scope_legacy_check']);
  });
});
