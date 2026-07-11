// Regression: POST /api/v1/custom-pricing with a bounded `effective_to` must
// preserve the tail of the interval it splits. closePreviousOverlap truncates
// the overlapped row at the new effective_from; if the new row is bounded and
// the prior interval extended past effective_to, the route must re-open
// [effective_to, priorEnd) at the prior price. Otherwise the previously-active
// price silently vanishes after the bounded window and later usage falls
// through to needs_input (metric) or the public catalog rate (LLM).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const NEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => ({
  builderId: '00000000-0000-4000-8000-000000000001',
  keyId: '99999999-9999-4999-8999-999999999999',
  execute: vi.fn(),
  auditLog: vi.fn(),
  nextVersionRows: [] as Array<{ effective_from: string }>,
  priorOverlapRows: [] as Array<{
    price_per_unit_usd: string;
    input_per_1m_usd: string | null;
    output_per_1m_usd: string | null;
    source: string;
    notes: string | null;
    effective_to: string | null;
  }>,
}));

vi.mock('../../src/lib/auth/builder-context.js', () => ({
  readBuilderContext: () => ({ builderId: mocks.builderId, keyId: mocks.keyId }),
}));

vi.mock('../../src/lib/auth/audit-log.js', () => ({
  auditLog: mocks.auditLog,
}));

vi.mock('../../src/lib/logger.js', () => ({
  logger: {
    child: () => ({ error: () => undefined, warn: () => undefined, info: () => undefined }),
  },
}));

vi.mock('../../src/lib/db/rls.js', () => ({
  withRLS: (_builderId: string, cb: (tx: { execute: typeof mocks.execute }) => unknown) =>
    cb({ execute: mocks.execute }),
}));

const { POST } = await import('../../src/app/api/v1/custom-pricing/route.js');

function sqlTextFor(query: unknown): string {
  return JSON.stringify(query, (_k, val) => (typeof val === 'function' ? undefined : val));
}

function sqlText(callIndex: number): string {
  return sqlTextFor(mocks.execute.mock.calls[callIndex]?.[0]);
}

function indexesMatching(...patterns: RegExp[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < mocks.execute.mock.calls.length; i++) {
    const text = sqlText(i);
    if (patterns.every((pattern) => pattern.test(text))) out.push(i);
  }
  return out;
}

function makeRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://localhost/api/v1/custom-pricing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  } as ConstructorParameters<typeof NextRequest>[1]);
}

function llmBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    metric: null,
    price_per_unit_usd: 0.000005,
    effective_from: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditLog.mockResolvedValue(undefined);
  mocks.nextVersionRows = [];
  mocks.priorOverlapRows = [];

  mocks.execute.mockImplementation((query: unknown) => {
    const text = sqlTextFor(query);
    if (text.includes('SELECT pg_advisory_xact_lock')) return Promise.resolve([]);
    if (text.includes('SELECT effective_from') && text.includes('ORDER BY effective_from ASC')) {
      return Promise.resolve(mocks.nextVersionRows);
    }
    if (
      text.includes('price_per_unit_usd::text') &&
      text.includes('ORDER BY effective_from DESC')
    ) {
      return Promise.resolve(mocks.priorOverlapRows);
    }
    if (text.includes('INSERT INTO custom_pricing') && text.includes('RETURNING id')) {
      return Promise.resolve([{ id: NEW_ID }]);
    }
    if (text.includes('INSERT INTO custom_pricing')) {
      // Continuation insert (no RETURNING).
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  });
});

describe('POST /api/v1/custom-pricing bounded insert tail preservation', () => {
  it('re-opens the tail of an open prior interval as a continuation row', async () => {
    mocks.priorOverlapRows = [
      {
        price_per_unit_usd: '0.000009',
        input_per_1m_usd: null,
        output_per_1m_usd: null,
        source: 'builder_manual',
        notes: null,
        effective_to: null,
      },
    ];

    const res = await POST(
      makeRequest(
        llmBody({
          effective_from: '2026-08-01T00:00:00.000Z',
          effective_to: '2026-09-01T00:00:00.000Z',
        }),
      ),
    );
    expect(res.status).toBe(201);

    // The overlapped prior row is snapshotted before truncation.
    expect(
      indexesMatching(/price_per_unit_usd::text/, /ORDER BY effective_from DESC/),
    ).toHaveLength(1);

    // Two inserts: the bounded row, then the continuation restoring the tail.
    const inserts = indexesMatching(/INSERT INTO custom_pricing/);
    expect(inserts).toHaveLength(2);

    const continuation = sqlText(inserts[1]!);
    // Continuation starts at the bounded row's end, carries the prior price,
    // and re-opens the previously-open interval (no bounded end).
    expect(continuation).toContain('2026-09-01T00:00:00.000Z');
    expect(continuation).toContain('0.000009');
    expect(continuation).not.toContain('0.000005');
  });

  it('re-opens the tail of a bounded prior interval up to its original end', async () => {
    mocks.priorOverlapRows = [
      {
        price_per_unit_usd: '0.000009',
        input_per_1m_usd: null,
        output_per_1m_usd: null,
        source: 'builder_manual',
        notes: null,
        effective_to: '2026-03-01T00:00:00.000Z',
      },
    ];

    const res = await POST(
      makeRequest(
        llmBody({
          effective_from: '2026-01-15T00:00:00.000Z',
          effective_to: '2026-02-01T00:00:00.000Z',
        }),
      ),
    );
    expect(res.status).toBe(201);

    const inserts = indexesMatching(/INSERT INTO custom_pricing/);
    expect(inserts).toHaveLength(2);

    const continuation = sqlText(inserts[1]!);
    expect(continuation).toContain('2026-02-01T00:00:00.000Z'); // continuation start
    expect(continuation).toContain('2026-03-01T00:00:00.000Z'); // original prior end
    expect(continuation).toContain('0.000009');
  });

  it('writes no continuation when the prior interval ends at effective_to', async () => {
    mocks.priorOverlapRows = [
      {
        price_per_unit_usd: '0.000009',
        input_per_1m_usd: null,
        output_per_1m_usd: null,
        source: 'builder_manual',
        notes: null,
        effective_to: '2026-02-01T00:00:00.000Z',
      },
    ];

    const res = await POST(
      makeRequest(
        llmBody({
          effective_from: '2026-01-15T00:00:00.000Z',
          effective_to: '2026-02-01T00:00:00.000Z',
        }),
      ),
    );
    expect(res.status).toBe(201);

    // priorEnd == effective_to -> no gap -> single insert only.
    expect(indexesMatching(/INSERT INTO custom_pricing/)).toHaveLength(1);
  });

  it('does not snapshot or continue for an open (unbounded) insert', async () => {
    const res = await POST(makeRequest(llmBody())); // no effective_to
    expect(res.status).toBe(201);

    // Fast path unchanged: no prior-overlap snapshot, single insert.
    expect(
      indexesMatching(/price_per_unit_usd::text/, /ORDER BY effective_from DESC/),
    ).toHaveLength(0);
    expect(indexesMatching(/INSERT INTO custom_pricing/)).toHaveLength(1);
  });
});
