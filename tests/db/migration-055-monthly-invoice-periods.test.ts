import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../db/migrations/055_monthly_invoice_period_retry.sql', import.meta.url),
  'utf8',
);

describe('migration 055 — durable monthly invoice retry periods', () => {
  it('persists one UTC-month period per builder and customer', () => {
    expect(migration).toContain('PRIMARY KEY (builder_id, customer_id, period_start)');
    expect(migration).toContain("CHECK (status IN ('pending', 'completed'))");
    expect(migration).toContain("period_start AT TIME ZONE 'UTC'");
    expect(migration).toContain("INTERVAL '1 month'");
  });

  it('keeps the table inside the general application owner boundary', () => {
    expect(migration).toContain('ALTER TABLE monthly_invoice_periods ENABLE ROW LEVEL SECURITY');
    expect(migration).toContain('CREATE POLICY monthly_invoice_periods_isolation');
    expect(migration).toContain('SET ROLE pylva_general_app_runtime');
    expect(migration).toContain('RESET ROLE');
  });
});
