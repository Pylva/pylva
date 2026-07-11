// Step 4 — /api/v1/livez is the shallow ECS liveness probe. It must stay
// dependency-free (no Postgres/Redis/ClickHouse) so it returns 200 even
// while ClickHouse is deferred (T#8) and /api/v1/health 503s.

import { describe, it, expect } from 'vitest';

const { GET } = await import('../../src/app/api/v1/livez/route.js');

describe('GET /api/v1/livez (ECS liveness)', () => {
  it('returns 200 + {status:"ok"} with no external dependencies', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: 'ok' });
  });
});
