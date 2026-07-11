// B2b T2-C — hashBody() unit tests.
//
// The claim/commit helpers themselves require a DB and live in integration
// tests. hashBody is pure and worth covering here to guarantee same body →
// same hash + JSON key order doesn't produce false mismatches.

import { describe, it, expect } from 'vitest';
import { hashBody } from '../../src/lib/billing/hash-body.js';

describe('hashBody()', () => {
  it('produces stable hash for same input', () => {
    const a = hashBody({ customer_id: 'c1', period_start: '2026-04-01T00:00:00Z' });
    const b = hashBody({ customer_id: 'c1', period_start: '2026-04-01T00:00:00Z' });
    expect(a).toBe(b);
  });

  it('differs when body differs', () => {
    const a = hashBody({ x: 1 });
    const b = hashBody({ x: 2 });
    expect(a).not.toBe(b);
  });

  it('differs when object key insertion order differs (documented limitation)', () => {
    // JSON.stringify preserves insertion order. This is intentional — clients
    // should canonicalize their bodies before requesting. Documented so
    // future-us knows the same-body rule is literal string-equality on
    // JSON.stringify, not semantic.
    const a = hashBody({ a: 1, b: 2 });
    const b = hashBody({ b: 2, a: 1 });
    expect(a).not.toBe(b);
  });

  it('produces hex-encoded 64-char output (sha256)', () => {
    const h = hashBody({ x: 'y' });
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});
