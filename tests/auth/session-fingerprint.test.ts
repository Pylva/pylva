// The pylva_active_session cookie is deliberately readable by client script,
// so its user half must be a truncated one-way hash — never the raw user id.

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { encodeActiveSessionValue, sessionFingerprint } from '@/lib/auth/session-fingerprint';

describe('sessionFingerprint', () => {
  it('returns 16 lowercase hex chars', () => {
    expect(sessionFingerprint('user-1')).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionFingerprint('0b9df1c2-4a55-4a10-bb37-1a2b3c4d5e6f')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic — the truncated sha256 of the user id', () => {
    const expected = crypto.createHash('sha256').update('user-1').digest('hex').slice(0, 16);
    expect(sessionFingerprint('user-1')).toBe(expected);
    expect(sessionFingerprint('user-1')).toBe(sessionFingerprint('user-1'));
  });

  it('differs for different user ids', () => {
    expect(sessionFingerprint('user-1')).not.toBe(sessionFingerprint('user-2'));
  });

  it('never contains the raw user id', () => {
    const userId = '0b9df1c2-4a55-4a10-bb37-1a2b3c4d5e6f';
    expect(sessionFingerprint(userId)).not.toContain(userId);
    expect(sessionFingerprint('user-1')).not.toContain('user-1');
    expect(encodeActiveSessionValue(userId, 'acme')).not.toContain(userId);
  });
});

describe('encodeActiveSessionValue', () => {
  it('is `${sessionFingerprint(userId)}.${slug}`', () => {
    expect(encodeActiveSessionValue('user-1', 'acme')).toBe(
      `${sessionFingerprint('user-1')}.acme`,
    );
    expect(encodeActiveSessionValue('user-1', 'acme')).toMatch(/^[0-9a-f]{16}\.acme$/);
  });
});
