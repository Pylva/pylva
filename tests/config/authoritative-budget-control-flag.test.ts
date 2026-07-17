import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FLAG = 'ENABLE_AUTHORITATIVE_BUDGET_CONTROL';
const REQUIRED_BASELINE: Record<string, string> = {
  DATABASE_URL: 'postgres://test/test',
  CLICKHOUSE_URL: 'http://localhost:8123',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '/dev/null',
  JWT_PUBLIC_KEY: '/dev/null',
  ARGON2_SECRET: 'test-secret-min',
};

async function loadFlagFresh(): Promise<boolean> {
  vi.resetModules();
  const { env } = await import('../../src/lib/config.js');
  return env.ENABLE_AUTHORITATIVE_BUDGET_CONTROL;
}

describe('ENABLE_AUTHORITATIVE_BUDGET_CONTROL', () => {
  beforeEach(() => {
    delete process.env[FLAG];
    for (const [key, value] of Object.entries(REQUIRED_BASELINE)) {
      if (!process.env[key]) process.env[key] = value;
    }
  });

  afterEach(() => {
    delete process.env[FLAG];
    vi.resetModules();
  });

  it('defaults off for safe pre-roll deployment', async () => {
    await expect(loadFlagFresh()).resolves.toBe(false);
  });

  it.each([
    ['true', true],
    ['false', false],
  ] as const)('parses %s explicitly', async (raw, expected) => {
    process.env[FLAG] = raw;

    await expect(loadFlagFresh()).resolves.toBe(expected);
  });

  it('documents the same disabled default in .env.example', async () => {
    const source = await fs.readFile(path.resolve(process.cwd(), '.env.example'), 'utf8');

    expect(source).toMatch(/^ENABLE_AUTHORITATIVE_BUDGET_CONTROL=false$/m);
    expect(source).not.toMatch(/^ENABLE_AUTHORITATIVE_BUDGET_CONTROL=true$/m);
  });
});
