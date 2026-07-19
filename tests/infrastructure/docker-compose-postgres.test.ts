import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const compose = readFileSync('docker/docker-compose.yml', 'utf8');

describe('self-host PostgreSQL persistence', () => {
  it('keeps the PostgreSQL image compatible with the persisted PGDATA mount', () => {
    expect(compose).toMatch(/^\s+image: postgres:16$/m);
    expect(compose).toMatch(/^\s+- pg_data:\/var\/lib\/postgresql\/data$/m);
    expect(compose).not.toMatch(/^\s+image: postgres:1[89]$/m);
  });
});
