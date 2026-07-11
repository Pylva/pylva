// B4-2b — model_routing helper. Pure unit tests for the
// fallback-classification + attempt-with-fallback logic.

import { describe, it, expect } from 'vitest';
import { attemptWithFallback, shouldFallback } from '../src/core/model_routing.js';
import type { ModelRoutingFallback } from '@pylva/shared';

const ALL_FALLBACK: ModelRoutingFallback = {
  on_cross_provider_auth_error: true,
  on_access_denied: true,
  on_model_not_found: true,
  use_original_model: true,
  skip_same_provider_401: true,
};

describe('shouldFallback — status classification', () => {
  it('cross-provider 401 → fallback', () => {
    expect(shouldFallback({ status: 401 }, ALL_FALLBACK, false)).toBe(true);
  });

  it('same-provider 401 → no fallback (D25 skip_same_provider_401)', () => {
    expect(shouldFallback({ status: 401 }, ALL_FALLBACK, true)).toBe(false);
  });

  it('403 always falls back when on_access_denied=true', () => {
    expect(shouldFallback({ status: 403 }, ALL_FALLBACK, false)).toBe(true);
    expect(shouldFallback({ status: 403 }, ALL_FALLBACK, true)).toBe(true);
  });

  it('404 always falls back when on_model_not_found=true', () => {
    expect(shouldFallback({ status: 404 }, ALL_FALLBACK, false)).toBe(true);
    expect(shouldFallback({ status: 404 }, ALL_FALLBACK, true)).toBe(true);
  });

  it('429 does not fall back', () => {
    expect(shouldFallback({ status: 429 }, ALL_FALLBACK, false)).toBe(false);
    expect(shouldFallback({ status: 429 }, ALL_FALLBACK, true)).toBe(false);
  });

  it('500 does not fall back', () => {
    expect(shouldFallback({ status: 500 }, ALL_FALLBACK, false)).toBe(false);
  });

  it('respects use_original_model=false', () => {
    const cfg: ModelRoutingFallback = { ...ALL_FALLBACK, use_original_model: false };
    expect(shouldFallback({ status: 401 }, cfg, false)).toBe(false);
    expect(shouldFallback({ status: 403 }, cfg, false)).toBe(false);
    expect(shouldFallback({ status: 404 }, cfg, false)).toBe(false);
  });

  it('respects per-status flags', () => {
    const cfg: ModelRoutingFallback = {
      ...ALL_FALLBACK,
      on_cross_provider_auth_error: false,
      on_access_denied: false,
      on_model_not_found: true,
    };
    expect(shouldFallback({ status: 401 }, cfg, false)).toBe(false);
    expect(shouldFallback({ status: 403 }, cfg, false)).toBe(false);
    expect(shouldFallback({ status: 404 }, cfg, false)).toBe(true);
  });
});

describe('attemptWithFallback', () => {
  it('returns the routed result on success (no fallback)', async () => {
    let calls: string[] = [];
    const out = await attemptWithFallback({
      call: async (model) => {
        calls.push(model);
        return { value: model };
      },
      routedModel: 'gpt-4o-mini',
      originalModel: 'gpt-4o',
      isSameProvider: true,
      fallback: ALL_FALLBACK,
    });
    expect(out.fellBack).toBe(false);
    expect(out.modelUsed).toBe('gpt-4o-mini');
    expect(out.result).toEqual({ value: 'gpt-4o-mini' });
    expect(calls).toEqual(['gpt-4o-mini']);
  });

  it('falls back to original model on cross-provider 401', async () => {
    const calls: string[] = [];
    const out = await attemptWithFallback({
      call: async (model) => {
        calls.push(model);
        if (model === 'mistral-small') {
          const err = new Error('auth') as Error & { status: number };
          err.status = 401;
          throw err;
        }
        return { value: model };
      },
      routedModel: 'mistral-small',
      originalModel: 'gpt-4o',
      isSameProvider: false,
      fallback: ALL_FALLBACK,
    });
    expect(out.fellBack).toBe(true);
    expect(out.modelUsed).toBe('gpt-4o');
    expect(out.fallbackReason).toBe('routing_fallback_auth_401');
    expect(calls).toEqual(['mistral-small', 'gpt-4o']);
  });

  it('does NOT retry on same-provider 401 (D25)', async () => {
    const calls: string[] = [];
    await expect(
      attemptWithFallback({
        call: async (model) => {
          calls.push(model);
          const err = new Error('auth') as Error & { status: number };
          err.status = 401;
          throw err;
        },
        routedModel: 'gpt-4o-mini',
        originalModel: 'gpt-4o',
        isSameProvider: true,
        fallback: ALL_FALLBACK,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(['gpt-4o-mini']);
  });

  it('does NOT retry on 429 (rate limit)', async () => {
    const calls: string[] = [];
    await expect(
      attemptWithFallback({
        call: async (model) => {
          calls.push(model);
          const err = new Error('rate limit') as Error & { status: number };
          err.status = 429;
          throw err;
        },
        routedModel: 'gpt-4o-mini',
        originalModel: 'gpt-4o',
        isSameProvider: false,
        fallback: ALL_FALLBACK,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(['gpt-4o-mini']);
  });

  it('does NOT retry on 500 (provider error)', async () => {
    const calls: string[] = [];
    await expect(
      attemptWithFallback({
        call: async (model) => {
          calls.push(model);
          const err = new Error('server error') as Error & { status: number };
          err.status = 500;
          throw err;
        },
        routedModel: 'gpt-4o-mini',
        originalModel: 'gpt-4o',
        isSameProvider: true,
        fallback: ALL_FALLBACK,
      }),
    ).rejects.toThrow();
    expect(calls).toEqual(['gpt-4o-mini']);
  });

  it('falls back on 403 access denied', async () => {
    const out = await attemptWithFallback({
      call: async (model) => {
        if (model === 'gpt-4o-mini') {
          const err = new Error('access denied') as Error & { status: number };
          err.status = 403;
          throw err;
        }
        return { value: model };
      },
      routedModel: 'gpt-4o-mini',
      originalModel: 'gpt-4o',
      isSameProvider: true,
      fallback: ALL_FALLBACK,
    });
    expect(out.fellBack).toBe(true);
    expect(out.fallbackReason).toBe('routing_fallback_access_403');
  });

  it('falls back on 404 model-not-found', async () => {
    const out = await attemptWithFallback({
      call: async (model) => {
        if (model === 'gpt-4o-mini') {
          const err = new Error('not found') as Error & { status: number };
          err.status = 404;
          throw err;
        }
        return { value: model };
      },
      routedModel: 'gpt-4o-mini',
      originalModel: 'gpt-4o',
      isSameProvider: true,
      fallback: ALL_FALLBACK,
    });
    expect(out.fellBack).toBe(true);
    expect(out.fallbackReason).toBe('routing_fallback_not_found_404');
  });

  it('propagates fallback-call errors', async () => {
    let attempt = 0;
    await expect(
      attemptWithFallback({
        call: async () => {
          attempt += 1;
          const err = new Error('always fails') as Error & { status: number };
          err.status = attempt === 1 ? 403 : 500;
          throw err;
        },
        routedModel: 'gpt-4o-mini',
        originalModel: 'gpt-4o',
        isSameProvider: true,
        fallback: ALL_FALLBACK,
      }),
    ).rejects.toThrow('always fails');
    expect(attempt).toBe(2);
  });
});
