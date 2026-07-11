// Tenant-isolation guardrail (static, no DB). Legitimate tenant-scoped writes go
// through withRLS(builderId, tx => tx.insert/update/delete(...)), so they use the
// transaction handle `tx`, never the raw `db` client. A direct
// db.insert/update/delete(...) therefore bypasses the RLS context and must be one
// of the small, deliberate global/pre-builder write paths listed below.
//
// This is the launch-time backstop for the "RLS is currently enforced by app-code
// filters" reality: if a new route adds a raw db mutation on tenant data, this
// test fails and the author must either wrap it in withRLS or justify adding it to
// the allowlist (via review). Reads are intentionally not guarded here — there are
// many legitimate global reads and a stray read cannot corrupt another tenant.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

// Files permitted to issue raw db.insert/update/delete because they run before a
// builder context exists (auth bootstrap) — see the pre-builder query inventory.
const ALLOWLIST = new Set<string>([
  'lib/auth/api-key.ts', // api_keys revoke/expire, keyed by key_id (pre-auth)
  'lib/auth/org.ts', // membership/builder creation during signup (pre-builder)
]);

const DIRECT_DB_MUTATION = /\bdb\.(?:insert|update|delete)\s*\(/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(abs);
    }
  }
  return out;
}

describe('tenant query scoping guardrail', () => {
  it('raw db.insert/update/delete only appears in allowlisted pre-builder paths', () => {
    const offenders = walk(srcRoot)
      .filter((abs) => DIRECT_DB_MUTATION.test(fs.readFileSync(abs, 'utf8')))
      .map((abs) => path.relative(srcRoot, abs))
      .filter((rel) => !ALLOWLIST.has(rel));

    expect(offenders).toEqual([]);
  });
});
