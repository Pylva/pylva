import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');

describe('postgres migration ordering', () => {
  it('keeps numeric migration prefixes unique', async () => {
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => /^\d+_.*\.sql$/.test(file))
      .sort();
    const byPrefix = new Map<string, string[]>();

    for (const file of files) {
      const prefix = file.split('_')[0]!;
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), file]);
    }

    const duplicates = [...byPrefix.entries()]
      .filter(([, grouped]) => grouped.length > 1)
      .map(([prefix, grouped]) => `${prefix}: ${grouped.join(', ')}`);

    expect(duplicates).toEqual([]);
  });

  it('removes customer-throttle rule events before removing customer-throttle rules', async () => {
    const src = await readFile(
      path.resolve(MIGRATIONS_DIR, '042_remove_customer_throttle_rule.sql'),
      'utf8',
    );

    const deleteEvents = src.search(/DELETE FROM rule_events/i);
    const staleEventType = src.search(/event_type\s*=\s*'throttle_blocked'/i);
    const customerRuleJoin = src.search(/rule_id\s+IN\s*\(\s*SELECT\s+id\s+FROM\s+rules/i);
    const deleteRules = src.search(/DELETE FROM rules\s+WHERE type\s*=\s*'customer_throttle'/i);

    expect(deleteEvents).toBeGreaterThanOrEqual(0);
    expect(staleEventType).toBeGreaterThan(deleteEvents);
    expect(customerRuleJoin).toBeGreaterThan(deleteEvents);
    expect(deleteRules).toBeGreaterThan(deleteEvents);
  });

  it('creates custom-rule requests with RLS read and write isolation', async () => {
    const src = await readFile(
      path.resolve(MIGRATIONS_DIR, '044_custom_rule_requests.sql'),
      'utf8',
    );

    expect(src).toMatch(/CREATE TABLE custom_rule_requests/i);
    expect(src).toMatch(/email_status\s+TEXT\s+NOT NULL\s+DEFAULT 'pending'/i);
    expect(src).toMatch(/ALTER TABLE custom_rule_requests ENABLE ROW LEVEL SECURITY/i);
    expect(src).toMatch(/USING\s*\(\s*builder_id\s*=\s*current_setting\('app\.builder_id'/i);
    expect(src).toMatch(/WITH CHECK\s*\(\s*builder_id\s*=\s*current_setting\('app\.builder_id'/i);
  });

});
