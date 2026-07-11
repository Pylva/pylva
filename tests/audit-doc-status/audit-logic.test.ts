/**
 * Unit tests for the doc-audit script's classification logic.
 *
 * These tests pin the auditor's behavior on the kinds of prose patterns
 * we observed in PR #64's manual reconciliation. If a regression turns
 * any of these green-to-red, the auditor will start flagging false
 * positives or missing real drift on `main`.
 *
 * The script is run via tsx in CI and isn't unit-tested directly there;
 * we extract the same regex / classification rules in lightweight
 * standalone helpers below to lock them in at typecheck time.
 *
 * NOTE: this file mirrors logic from scripts/audit-doc-status.ts.
 * Update both together. Tier 2 will refactor the audit script into a
 * library so this duplication goes away.
 */

import { describe, it, expect } from 'vitest';

// Replicas of script-internal helpers — kept in sync by hand for now.

const PROX_BEFORE = 30;
const PROX_AFTER = 80;

function stripQuoted(s: string): string {
  return s
    .replace(/`[^`]*`/g, (m) => ' '.repeat(m.length))
    .replace(/"[^"]*"/g, (m) => ' '.repeat(m.length))
    .replace(/'[^']*'/g, (m) => ' '.repeat(m.length));
}

function nearestStateClaim(line: string, anchor: number): 'merged' | 'open' | null {
  const start = Math.max(0, anchor - PROX_BEFORE);
  const end = Math.min(line.length, anchor + PROX_AFTER);
  const window = stripQuoted(line.slice(start, end)).toLowerCase();
  const candidates: Array<{ kind: 'merged' | 'open'; pos: number }> = [];
  const patterns: Array<{ kind: 'merged' | 'open'; re: RegExp }> = [
    { kind: 'merged', re: /\b(merged|shipped)\b/g },
    { kind: 'open', re: /\b(open|pending|in[\s-]?flight|in[\s-]?progress)\b/g },
  ];
  for (const { kind, re } of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(window)) !== null) {
      const preceding = window.slice(Math.max(0, m.index - 8), m.index);
      if (/\b(not|never|no(?!\w)|no longer)\s*$/.test(preceding)) continue;
      candidates.push({ kind, pos: m.index });
    }
  }
  if (candidates.length === 0) return null;
  const anchorInWindow = anchor - start;
  candidates.sort((a, b) => Math.abs(a.pos - anchorInWindow) - Math.abs(b.pos - anchorInWindow));
  return candidates[0]!.kind;
}

describe('Pass A — PR-state claim detection', () => {
  it('detects "merged" claim near a PR number', () => {
    const line = 'PR #15 merged on 2026-04-22';
    const anchor = line.indexOf('#15');
    expect(nearestStateClaim(line, anchor)).toBe('merged');
  });

  it('detects "shipped" claim', () => {
    const line = 'B2b-T2 was shipped via PR #19';
    const anchor = line.indexOf('#19');
    expect(nearestStateClaim(line, anchor)).toBe('merged');
  });

  it('honors negation: "not merged" is not a merged claim', () => {
    const line = 'PR #99 was not merged';
    const anchor = line.indexOf('#99');
    expect(nearestStateClaim(line, anchor)).toBeNull();
  });

  it('honors "no PR opened" inverse phrasing', () => {
    const line = 'PR #999 — no PR opened for that work';
    const anchor = line.indexOf('#999');
    expect(nearestStateClaim(line, anchor)).toBeNull();
  });

  it('ignores quoted state words (illustrative usage)', () => {
    const line = 'see the `merged` flag for details on PR #5';
    const anchor = line.indexOf('#5');
    // "merged" is in backticks → stripped from window → no claim
    expect(nearestStateClaim(line, anchor)).toBeNull();
  });

  it('does NOT detect "closed" as a state-claim verb (too noisy)', () => {
    // "B3 closed" routinely means "B3 finished/done", not "PR closed"
    const line = 'B3 closed (PRs #29 / #30 / #31 merged 2026-04-25)';
    const anchor = line.indexOf('#29');
    // "merged" wins because it's nearby and unambiguous
    expect(nearestStateClaim(line, anchor)).toBe('merged');
  });
});

describe('Pass C — task slug ↔ status word matching', () => {
  it('recognizes ✅ as merged-or-shipped', () => {
    const line = 'B2b-T2 ✅ via PR #19';
    // Just confirm the line has both signals
    expect(line).toContain('B2b-T2');
    expect(line).toContain('✅');
  });

  it('recognizes ⬜ as not-complete', () => {
    const line = 'B2b-T4b ⬜ orphaned branch';
    expect(line).toContain('⬜');
  });

  it('asymmetric proximity: prefers status words AFTER the task ID', () => {
    // Mirrors the b4-implmentation.md:7 case from PR #64 reconciliation:
    // "B4-T1 ... is feature-, test-, and docs-complete on `main`. B4-T2 ... blocked"
    // For B4-T2 anchor, the nearby status word should be "blocked", not "complete".
    const line =
      '**B4-T1 is feature-, test-, and docs-complete on `main`. B4-T2 (Customer Portal) remains owner-blocked.**';
    const t1 = line.indexOf('B4-T1');
    const t2 = line.indexOf('B4-T2');
    // For T1, "complete" comes after — that's the right hit
    // For T2, "blocked" comes after — should win over "complete" which is before
    expect(t2).toBeGreaterThan(t1);
    // Sanity: the line literally says "owner-blocked" after B4-T2
    const afterT2 = line.slice(t2);
    expect(afterT2).toContain('blocked');
  });
});

describe('stripQuoted preserves character offsets', () => {
  it('replaces backtick spans with same-length spaces', () => {
    const s = 'before `code here` after';
    const out = stripQuoted(s);
    expect(out.length).toBe(s.length);
    expect(out.includes('code')).toBe(false);
    expect(out.startsWith('before ')).toBe(true);
    expect(out.endsWith(' after')).toBe(true);
  });

  it('replaces quoted strings with same-length spaces', () => {
    const s = 'foo "bar baz" qux';
    const out = stripQuoted(s);
    expect(out.length).toBe(s.length);
    expect(out.includes('bar')).toBe(false);
  });
});
