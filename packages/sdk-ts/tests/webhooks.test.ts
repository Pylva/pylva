import { describe, it, expect } from 'vitest';
import { verifyWebhook, signWebhook, InvalidSignatureFormat } from '../src/webhooks/verify.js';

const SECRET = 'whsec_test_secret';
const BODY = JSON.stringify({ event: 'cost_threshold', amount: 100 });

describe('verifyWebhook (D7)', () => {
  it('accepts a valid signature + in-tolerance timestamp', () => {
    const timestamp = '1700000000';
    const { signature } = signWebhook(BODY, SECRET, timestamp);
    const now = 1_700_000_050_000; // 50s after timestamp
    expect(verifyWebhook(BODY, signature, SECRET, timestamp, { now: () => now })).toBe(true);
  });

  it('rejects an expired timestamp (>300s)', () => {
    const timestamp = '1700000000';
    const { signature } = signWebhook(BODY, SECRET, timestamp);
    const now = 1_700_000_500_000; // 500s after — outside 300s tolerance
    expect(verifyWebhook(BODY, signature, SECRET, timestamp, { now: () => now })).toBe(false);
  });

  it('rejects a tampered body', () => {
    const timestamp = '1700000000';
    const { signature } = signWebhook(BODY, SECRET, timestamp);
    const now = 1_700_000_050_000;
    expect(verifyWebhook(BODY + 'tampered', signature, SECRET, timestamp, { now: () => now })).toBe(
      false,
    );
  });

  it('throws InvalidSignatureFormat on non-integer timestamp', () => {
    const timestamp = 'not-a-number';
    const { signature } = signWebhook(BODY, SECRET, '1700000000');
    expect(() => verifyWebhook(BODY, signature, SECRET, timestamp)).toThrow(InvalidSignatureFormat);
  });

  it('throws InvalidSignatureFormat on malformed signature', () => {
    expect(() => verifyWebhook(BODY, 'xyz', SECRET, '1700000000')).toThrow(InvalidSignatureFormat);
  });

  it('honors custom toleranceSeconds', () => {
    const timestamp = '1700000000';
    const { signature } = signWebhook(BODY, SECRET, timestamp);
    const now = 1_700_000_100_000; // 100s after
    expect(
      verifyWebhook(BODY, signature, SECRET, timestamp, { toleranceSeconds: 50, now: () => now }),
    ).toBe(false);
    expect(
      verifyWebhook(BODY, signature, SECRET, timestamp, { toleranceSeconds: 200, now: () => now }),
    ).toBe(true);
  });
});

describe('signWebhook', () => {
  it('produces a 64-hex signature', () => {
    const { signature, timestamp } = signWebhook(BODY, SECRET);
    expect(signature).toMatch(/^[a-f0-9]{64}$/);
    expect(timestamp).toMatch(/^\d+$/);
  });

  it('round-trips with verifyWebhook', () => {
    const { signature, timestamp } = signWebhook(BODY, SECRET);
    expect(verifyWebhook(BODY, signature, SECRET, timestamp)).toBe(true);
  });
});
