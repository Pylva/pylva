// Stripe-style webhook verification (D7).
// Signature covers `${timestamp}.${body}` with HMAC-SHA256. Tolerance defaults
// to 300 s. Tampering, expired timestamp, or mismatch → false. Malformed
// input → InvalidSignatureFormat.
//
// B2a D34: accept both raw hex and `sha256=${hex}` prefixed signatures for
// back-compat with webhook consumers that expect the GitHub-style prefix.

import { createHmac, timingSafeEqual } from 'node:crypto';

export class InvalidSignatureFormat extends Error {
  constructor(message: string) {
    super(`[pylva] ${message}`);
    this.name = 'InvalidSignatureFormat';
  }
}

Object.defineProperty(InvalidSignatureFormat, 'name', { value: 'InvalidSignatureFormat' });

export interface VerifyWebhookOptions {
  toleranceSeconds?: number;
  now?: () => number; // epoch ms; for tests
}

function sign(body: string, secret: string, timestamp: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

// Strip an optional `sha256=` prefix. Returns the raw hex portion or the input
// unchanged. Called before shape-validation so the regex sees only the digest.
function stripSha256Prefix(signature: string): string {
  const prefix = 'sha256=';
  return signature.startsWith(prefix) ? signature.slice(prefix.length) : signature;
}

export function verifyWebhook(
  body: string,
  signature: string,
  secret: string,
  timestamp: string,
  options: VerifyWebhookOptions = {},
): boolean {
  const tolerance = options.toleranceSeconds ?? 300;
  const now = (options.now ?? Date.now)();

  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) {
    throw new InvalidSignatureFormat('timestamp must be an integer (epoch seconds) as a string');
  }

  const digest = typeof signature === 'string' ? stripSha256Prefix(signature) : signature;
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/i.test(digest)) {
    throw new InvalidSignatureFormat(
      'signature must be a 64-character hex HMAC-SHA256 digest (optionally prefixed with "sha256=")',
    );
  }

  const tsSec = Number(timestamp);
  if (Math.abs(now / 1000 - tsSec) > tolerance) {
    return false;
  }

  const expected = sign(body, secret, timestamp);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(digest, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface SignWebhookResult {
  signature: string;
  timestamp: string;
}

/**
 * Sign a webhook body. Returns a raw hex digest by default; pass
 * `prefix: 'sha256='` to get the GitHub-style prefixed form for delivery
 * (verifyWebhook accepts both on the receive side).
 */
export function signWebhook(
  body: string,
  secret: string,
  timestamp?: string,
  options?: { prefix?: 'sha256=' | '' },
): SignWebhookResult {
  const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
  const raw = sign(body, secret, ts);
  const prefix = options?.prefix ?? '';
  return { signature: `${prefix}${raw}`, timestamp: ts };
}
