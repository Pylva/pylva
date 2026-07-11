// Shared synthetic test env baseline so config.ts validates in public product tests.
export const TEST_PUBLIC_SITE_URL = 'https://pylva.test';

const baseline: Record<string, string> = {
  DATABASE_URL: 'postgres://test/test',
  CLICKHOUSE_URL: 'http://localhost:8123',
  REDIS_URL: 'redis://localhost:6379',
  JWT_PRIVATE_KEY: '/dev/null',
  JWT_PUBLIC_KEY: '/dev/null',
  ARGON2_SECRET: 'test-secret-min',
  PUBLIC_SITE_URL: TEST_PUBLIC_SITE_URL,
};

for (const [key, value] of Object.entries(baseline)) {
  if (!process.env[key]) {
    process.env[key] = value;
  }
}
