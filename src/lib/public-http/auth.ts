import { ErrorCode } from '@pylva/shared';
import { validateApiKey } from '../auth/api-key.js';
import { redisClient } from '../redis/client.js';
import { rateLimitBreaker } from '../redis/circuit-breaker.js';
import {
  authErrorResponse,
  type PublicHttpResponse,
  rateLimitErrorResponse,
} from './response.js';
import type { HeaderReader } from './headers.js';

export interface PublicApiKeyContext {
  builderId: string;
  keyId: string;
}

const TELEMETRY_LIMIT = { maxRequests: 1000, windowMs: 60_000 };

async function checkTelemetryRateLimit(keyId: string): Promise<PublicHttpResponse | null> {
  try {
    const result = (await rateLimitBreaker.fire(async () => {
      const now = Date.now();
      const windowKey = `rate_limit:telemetry:${keyId}:${Math.floor(now / TELEMETRY_LIMIT.windowMs)}`;
      const multi = redisClient.multi();
      multi.incr(windowKey);
      multi.pExpire(windowKey, TELEMETRY_LIMIT.windowMs);
      const replies = await multi.exec();
      return replies[0] as unknown as number;
    })) as number | null;
    if (result === null || result <= TELEMETRY_LIMIT.maxRequests) return null;
    return rateLimitErrorResponse(Math.ceil(TELEMETRY_LIMIT.windowMs / 1000));
  } catch {
    console.warn('[rate-limit] Redis error, allowing request (fail-open)');
    return null;
  }
}

// One universal key (migration 048): any valid key may send telemetry, so
// there is no scope check. Note: this module currently has no callers — it is
// reserved for a standalone ingest service.
export async function authenticateTelemetryRequest(
  headers: HeaderReader,
): Promise<PublicApiKeyContext | PublicHttpResponse> {
  const key = headers.get('X-Pylva-Key');
  if (!key) return authErrorResponse(ErrorCode.INVALID_API_KEY, 'Missing X-Pylva-Key header');

  const result = await validateApiKey(key);
  if (!result) return authErrorResponse(ErrorCode.INVALID_API_KEY, 'Invalid API key');

  const rateLimit = await checkTelemetryRateLimit(result.keyId);
  if (rateLimit) return rateLimit;

  return { builderId: result.builderId, keyId: result.keyId };
}
