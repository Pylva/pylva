import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const runbook = readFileSync('docs/authoritative-budget-control-operations.md', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');

describe('authoritative budget expiry operations contract', () => {
  it('documents the authenticated minute scheduler and both supported verbs', () => {
    expect(runbook).toContain('at least once per minute');
    expect(runbook).toContain('POST /api/cron/expire-budget-reservations');
    expect(runbook).toContain('GET  /api/cron/expire-budget-reservations');
    expect(runbook).toContain('Authorization: Bearer <CRON_SECRET>');
  });

  it('warns operators not to strand existing holds with the reserve kill switch', () => {
    expect(runbook).toContain('including while `ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false`');
    expect(runbook).toContain('must not strand reservations');
  });

  it('records partial/all failure, cache, retry, and sensitive-log semantics', () => {
    expect(runbook).toContain('`200`, `errors > 0`');
    expect(runbook).toContain('`401`');
    expect(runbook).toContain('`500`');
    expect(runbook).toContain('`Cache-Control: no-store`');
    expect(runbook).toContain('never exception messages');
  });

  it('keeps hosted scheduling authority out of the public repository', () => {
    expect(runbook).toContain('public repository intentionally does not own');
    expect(runbook).toContain('private deployment overlay');
  });

  it('points environment setup at the operational runbook', () => {
    expect(envExample).toContain('docs/authoritative-budget-control-operations.md');
    expect(envExample).toContain('/api/cron/expire-budget-reservations');
  });
});
