import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

async function migration(filename: string): Promise<string> {
  return readFile(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

describe('Free-plan expand/contract migrations', () => {
  it('expands lifecycle state without an implicit plan and handles hosted/self-hosted separately', async () => {
    const sql = await migration('056_workspace_access_state_expand.sql');

    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS access_state VARCHAR\(32\)/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS entitlement_source VARCHAR\(32\)/i);
    expect(sql).not.toMatch(/ALTER COLUMN tier DROP DEFAULT/i);
    expect(sql).toMatch(/ALTER COLUMN tier DROP NOT NULL/i);
    expect(sql).toMatch(/SET ROLE pylva_general_app_runtime/i);
    expect(sql).toMatch(/to_regclass\('public\.builder_subscriptions'\)/i);
    expect(sql).toMatch(/Free workspace ids \(up to 20\)/i);
    expect(sql).toMatch(/workspace access-state migration blocked/i);
    expect(sql).toMatch(/deferring workspace lifecycle backfill to companion migration 057/i);
    expect(sql).not.toMatch(/FROM builder_subscriptions/i);
    expect(sql).toMatch(/entitlement_source = 'self_hosted'/i);
    expect(sql).toMatch(/builders_no_new_free_during_expand_check/i);
    expect(sql).toMatch(/CHECK \(tier IS DISTINCT FROM 'free'\) NOT VALID/i);
    expect(sql).toMatch(/VALIDATE CONSTRAINT builders_no_new_free_during_expand_check/i);
  });

  it('contracts to paid plans only after explicit zero-row and drained-writer gates', async () => {
    const sql = await migration('058_remove_free_plan_contract.sql');

    expect(sql).toMatch(/migration-preflight: ok T8/i);
    expect(sql).toMatch(/WHERE tier = 'free'/i);
    expect(sql).toMatch(/Free-plan contract migration blocked/i);
    expect(sql).toMatch(/WHERE access_state IS NULL/i);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS builders_tier_check/i);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS builders_no_new_free_during_expand_check/i);
    expect(sql).toMatch(/ALTER COLUMN tier DROP DEFAULT/i);
    expect(sql).toMatch(/CHECK \(tier IS NULL OR tier IN \('pro', 'scale', 'enterprise'\)\)/i);
    expect(sql).toMatch(/ALTER COLUMN access_state SET NOT NULL/i);
    expect(sql).toMatch(/builders_entitlement_combination_check/i);
    expect(sql).not.toMatch(/tier IN \([^)]*'free'/i);
  });

  it('never rewrites ClickHouse rows or historical retention during PostgreSQL removal', async () => {
    const sql = `${await migration('056_workspace_access_state_expand.sql')}\n${await migration(
      '058_remove_free_plan_contract.sql',
    )}`;

    expect(sql).not.toMatch(/\bclickhouse\b/i);
    expect(sql).not.toMatch(/\bcost_events\b/i);
    expect(sql).not.toMatch(/\bretention_days\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+.*\bDELETE\b/i);
  });

  it('ships a reviewed forward re-expansion template without restoring a Free default', async () => {
    const sql = await readFile(
      path.resolve(__dirname, '../../docs/runbooks/remove-free-forward-reexpand.sql'),
      'utf8',
    );
    const executableSql = sql.replace(/^--.*$/gm, '');

    expect(sql).toMatch(/REVIEWED OPERATOR TEMPLATE.*NEVER AUTO-APPLIED/i);
    expect(sql).toMatch(/newly numbered, reviewed forward migration/i);
    expect(sql).toMatch(/db:migrate wraps each file in sql\.begin\(\)/i);
    expect(executableSql).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK)\s*;/imu);
    expect(executableSql).toMatch(/ALTER COLUMN access_state DROP NOT NULL/i);
    expect(executableSql).toMatch(/tier IS NULL OR tier IN \('pro', 'scale', 'enterprise'\)/i);
    expect(executableSql).not.toMatch(/tier\s*=\s*'free'|tier IN \([^)]*'free'/i);
    expect(executableSql).toMatch(/RESET ROLE\s*;/i);
    expect(sql).toMatch(/A pre-expand binary remains unsafe/i);
    expect(executableSql).not.toMatch(/ALTER COLUMN tier SET DEFAULT/i);
  });
});
