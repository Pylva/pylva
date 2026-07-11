// B2a — retry harness with [1s, 5s, 30s] backoff (D35).
//
// Total wall-clock budget ~36s. Callers decide retry-eligibility (e.g. 5xx
// retryable, 4xx not) via the `retryable` predicate; default retries on any
// thrown error. Exhaustion returns { ok: false } — the caller writes to DLQ.
//
// Hot-path lesson from B1 (L10): Promise.all fires concurrently; here we
// run strictly sequential per-channel since backoff is the whole point.

import type { DeliveryResult } from '@pylva/shared';

export const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000] as const;

export interface RetryOptions {
  backoffMs?: readonly number[];
  retryable?: (err: unknown) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<DeliveryResult & { value?: T }> {
  const backoff = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  const retryable = options.retryable ?? (() => true);
  const sleep = options.sleep ?? defaultSleep;

  const attempts = backoff.length + 1; // initial + each backoff
  let lastError: unknown = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const value = await fn();
      return { ok: true, attempts: i + 1, value };
    } catch (err) {
      lastError = err;
      if (i === attempts - 1) break;
      if (!retryable(err)) break;
      const delay = backoff[i] ?? 0;
      if (delay > 0) await sleep(delay);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return { ok: false, attempts, last_error: message };
}

/** Classify HTTP-ish failures as retryable. 5xx + network → retry; 4xx → no. */
export function isRetryableHttpError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    if (/\b(401|403|404)\b/.test(msg)) return false;
    if (/\b4\d\d\b/.test(msg)) {
      if (/\b429\b/.test(msg)) return true; // rate limit — treat as retryable
      return false;
    }
    return true;
  }
  return true;
}
