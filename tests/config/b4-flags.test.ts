// B4-0a — confirm the B4 kill switches exist and toggle independently.
// `@t3-oss/env-core` caches the parsed env object on first read, so each
// test calls `vi.resetModules()` and dynamically imports config to get a
// fresh env snapshot.
//
// Frontend launch §5: ENABLE_ADVANCED_RULES and ENABLE_PORTAL default to
// `true` because the public site sells those features. Portal OAuth +
// custom domains remain false until rolled out.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const B4_FLAGS = [
  'ENABLE_ADVANCED_RULES',
  'ENABLE_PORTAL',
  'ENABLE_PORTAL_OAUTH',
  'ENABLE_PORTAL_CUSTOM_DOMAINS',
] as const;

const EVENT_LIMIT_FLAGS = ['ENABLE_EVENT_LIMITS'] as const;

const DEFAULTS: Record<(typeof B4_FLAGS)[number], boolean> = {
  ENABLE_ADVANCED_RULES: true,
  ENABLE_PORTAL: true,
  ENABLE_PORTAL_OAUTH: false,
  ENABLE_PORTAL_CUSTOM_DOMAINS: false,
};

const REQUIRED_BASELINE: Record<string, string> = {
  DATABASE_URL: 'postgres://test/test',
  CLICKHOUSE_URL: 'http://localhost:8123',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '/dev/null',
  JWT_PUBLIC_KEY: '/dev/null',
  ARGON2_SECRET: 'test-secret-min',
};

async function loadConfigFresh(): Promise<Record<string, unknown>> {
  vi.resetModules();
  const mod = await import('../../src/lib/config.js');
  return mod.env as unknown as Record<string, unknown>;
}

describe('B4 kill switches', () => {
  beforeEach(() => {
    for (const key of B4_FLAGS) delete process.env[key];
    for (const key of EVENT_LIMIT_FLAGS) delete process.env[key];
    for (const [key, value] of Object.entries(REQUIRED_BASELINE)) {
      if (!process.env[key]) process.env[key] = value;
    }
  });

  it('B4 flags use launch defaults when unset', async () => {
    const env = await loadConfigFresh();
    for (const key of B4_FLAGS) {
      expect(env[key], key).toBe(DEFAULTS[key]);
    }
  });

  it('flags can be flipped via env=true', async () => {
    for (const key of B4_FLAGS) process.env[key] = 'true';
    const env = await loadConfigFresh();
    for (const key of B4_FLAGS) {
      expect(env[key]).toBe(true);
    }
  });

  it('flags toggle independently', async () => {
    process.env['ENABLE_ADVANCED_RULES'] = 'true';
    process.env['ENABLE_PORTAL'] = 'false';
    process.env['ENABLE_PORTAL_OAUTH'] = 'true';
    process.env['ENABLE_PORTAL_CUSTOM_DOMAINS'] = 'false';
    const env = await loadConfigFresh();
    expect(env['ENABLE_ADVANCED_RULES']).toBe(true);
    expect(env['ENABLE_PORTAL']).toBe(false);
    expect(env['ENABLE_PORTAL_OAUTH']).toBe(true);
    expect(env['ENABLE_PORTAL_CUSTOM_DOMAINS']).toBe(false);
  });

  it('defaults event-cap enforcement off for self-host', async () => {
    const env = await loadConfigFresh();

    expect(env['ENABLE_EVENT_LIMITS']).toBe(false);
  });

  it('can enable event-cap enforcement independently', async () => {
    process.env['ENABLE_EVENT_LIMITS'] = 'true';

    const env = await loadConfigFresh();

    expect(env['ENABLE_EVENT_LIMITS']).toBe(true);
  });
});
