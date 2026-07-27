import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LIMIT_KEYS = [
  'SELF_HOSTED_MONTHLY_EVENTS_LIMIT',
  'SELF_HOSTED_MAX_CUSTOMERS',
  'SELF_HOSTED_TELEMETRY_RETENTION_DAYS',
  'SELF_HOSTED_BILLING_RETENTION_DAYS',
] as const;

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

describe('self-hosted deployment limits', () => {
  beforeEach(() => {
    for (const key of LIMIT_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(REQUIRED_BASELINE)) {
      process.env[key] ??= value;
    }
  });

  afterEach(() => {
    for (const key of LIMIT_KEYS) delete process.env[key];
    vi.resetModules();
  });

  it('materializes documented deployment-level defaults', async () => {
    const env = await loadConfigFresh();

    expect(Object.fromEntries(LIMIT_KEYS.map((key) => [key, env[key]]))).toEqual({
      SELF_HOSTED_MONTHLY_EVENTS_LIMIT: 10_000_000,
      SELF_HOSTED_MAX_CUSTOMERS: 500,
      SELF_HOSTED_TELEMETRY_RETENTION_DAYS: 365,
      SELF_HOSTED_BILLING_RETENTION_DAYS: 365,
    });
  });

  it('accepts fully overridden positive bounded integer policy', async () => {
    process.env['SELF_HOSTED_MONTHLY_EVENTS_LIMIT'] = '123456';
    process.env['SELF_HOSTED_MAX_CUSTOMERS'] = '321';
    process.env['SELF_HOSTED_TELEMETRY_RETENTION_DAYS'] = '90';
    process.env['SELF_HOSTED_BILLING_RETENTION_DAYS'] = '730';

    const env = await loadConfigFresh();

    expect(env['SELF_HOSTED_MONTHLY_EVENTS_LIMIT']).toBe(123_456);
    expect(env['SELF_HOSTED_MAX_CUSTOMERS']).toBe(321);
    expect(env['SELF_HOSTED_TELEMETRY_RETENTION_DAYS']).toBe(90);
    expect(env['SELF_HOSTED_BILLING_RETENTION_DAYS']).toBe(730);
  });

  it.each([
    ['SELF_HOSTED_MONTHLY_EVENTS_LIMIT', '0'],
    ['SELF_HOSTED_MAX_CUSTOMERS', '1.5'],
    ['SELF_HOSTED_TELEMETRY_RETENTION_DAYS', '18251'],
    ['SELF_HOSTED_BILLING_RETENTION_DAYS', 'not-a-number'],
  ])('rejects invalid %s=%s', async (key, value) => {
    process.env[key] = value;

    await expect(loadConfigFresh()).rejects.toThrow();
  });

  it('rejects billing retention shorter than telemetry retention', async () => {
    process.env['SELF_HOSTED_TELEMETRY_RETENTION_DAYS'] = '366';
    process.env['SELF_HOSTED_BILLING_RETENTION_DAYS'] = '365';

    await expect(loadConfigFresh()).rejects.toThrow(
      /BILLING_RETENTION_DAYS must be greater than or equal to/i,
    );
  });
});
