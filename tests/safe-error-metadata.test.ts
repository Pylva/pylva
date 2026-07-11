import { describe, expect, it } from 'vitest';
import { safeErrorMetadata } from '../src/lib/safe-error-metadata';

describe('safeErrorMetadata', () => {
  it('captures top-level and one-level cause diagnostics without messages', () => {
    const cause = Object.assign(new Error('Invalid IP address: undefined for secret-token'), {
      code: 'ERR_INVALID_IP_ADDRESS',
    });
    const error = Object.assign(new TypeError('fetch failed for leaked@example.com', { cause }), {
      code: 'EXTERNAL_FETCH_FAILED',
      status: 502,
    });

    const metadata = safeErrorMetadata(error);

    expect(metadata).toEqual({
      cause_code: 'ERR_INVALID_IP_ADDRESS',
      cause_name: 'Error',
      error_code: 'EXTERNAL_FETCH_FAILED',
      error_name: 'TypeError',
      error_status: 502,
    });
    const serialized = JSON.stringify(metadata);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('leaked@example.com');
    expect(serialized).not.toContain('fetch failed');
  });

  it('supports provider-style errors and non-error values', () => {
    expect(
      safeErrorMetadata({ name: 'OAuthProviderError', code: 'invalid_grant', status: 401 }),
    ).toEqual({
      error_code: 'invalid_grant',
      error_name: 'OAuthProviderError',
      error_status: 401,
    });
    expect(safeErrorMetadata('failed')).toEqual({ error_name: 'string' });
  });
});
