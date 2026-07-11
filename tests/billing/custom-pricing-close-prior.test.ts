// Regression: POST /api/v1/custom-pricing must maintain non-overlapping
// half-open pricing intervals for a builder/key. Forward corrections close the
// previous interval; backdated inserts are bounded to the next later version.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server.js';

const NEW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PATCH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const mocks = vi.hoisted(() => ({
  builderId: '00000000-0000-4000-8000-000000000001',
  keyId: '99999999-9999-4999-8999-999999999999',
  execute: vi.fn(),
  auditLog: vi.fn(),
  nextVersionRows: [] as Array<{ effective_from: string }>,
  otherOpenRows: [] as Array<{ id: string }>,
  patchRow: null as null | {
    id: string;
    provider: string | null;
    model: string | null;
    metric: string | null;
    price_per_unit_usd: string;
    input_per_1m_usd: string | null;
    output_per_1m_usd: string | null;
    effective_from: string;
    effective_to: string | null;
    notes: string | null;
  },
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

const { DELETE, GET, PATCH, POST } = await import('../../src/app/api/v1/custom-pricing/route.js');

function sqlTextFor(query: unknown): string {
  return JSON.stringify(query, (_k, val) => (typeof val === 'function' ? undefined : val));
}

function sqlText(callIndex: number): string {
  return sqlTextFor(mocks.execute.mock.calls[callIndex]?.[0]);
}

function firstIndexMatching(...patterns: RegExp[]): number {
  for (let i = 0; i < mocks.execute.mock.calls.length; i++) {
    const text = sqlText(i);
    if (patterns.every((pattern) => pattern.test(text))) return i;
  }
  return -1;
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
    effective_from: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

function metricBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: null,
    model: null,
    metric: 'elevenlabs_characters',
    price_per_unit_usd: 0.00003,
    effective_from: '2026-06-20T00:00:00.000Z',
    ...overrides,
  };
}

function patchRow(overrides: Partial<NonNullable<typeof mocks.patchRow>> = {}) {
  return {
    id: PATCH_ID,
    provider: 'openai',
    model: 'gpt-4o',
    metric: null,
    price_per_unit_usd: '0.000005',
    input_per_1m_usd: null,
    output_per_1m_usd: null,
    effective_from: '2026-06-01T00:00:00.000Z',
    effective_to: '2026-06-15T00:00:00.000Z',
    notes: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.auditLog.mockResolvedValue(undefined);
  mocks.nextVersionRows = [];
  mocks.otherOpenRows = [];
  mocks.patchRow = null;

  mocks.execute.mockImplementation((query: unknown) => {
    const text = sqlTextFor(query);
    if (text.includes('SELECT pg_advisory_xact_lock')) return Promise.resolve([]);
    if (text.includes('SELECT effective_from') && text.includes('ORDER BY effective_from ASC')) {
      return Promise.resolve(mocks.nextVersionRows);
    }
    if (
      text.includes('SELECT id') &&
      text.includes('effective_to IS NULL') &&
      !text.includes('RETURNING id')
    ) {
      return Promise.resolve(mocks.otherOpenRows);
    }
    if (text.includes('SELECT id, provider, model, metric')) {
      return Promise.resolve(mocks.patchRow ? [mocks.patchRow] : []);
    }
    if (text.includes('INSERT INTO custom_pricing')) {
      return Promise.resolve([{ id: NEW_ID }]);
    }
    if (text.includes('UPDATE custom_pricing') && text.includes('RETURNING id')) {
      return Promise.resolve([{ id: PATCH_ID }]);
    }
    if (text.includes('DELETE FROM custom_pricing')) {
      return Promise.resolve([{ id: PATCH_ID }]);
    }
    return Promise.resolve([]);
  });
});

describe('POST /api/v1/custom-pricing interval writes', () => {
  it('locks the LLM key and closes a previous overlapping row before inserting', async () => {
    const res = await POST(makeRequest(llmBody()));
    expect(res.status).toBe(201);

    const lockIdx = firstIndexMatching(/pg_advisory_xact_lock/);
    const updateIdx = firstIndexMatching(/UPDATE custom_pricing/, /effective_from </);
    const insertIdx = firstIndexMatching(/INSERT INTO custom_pricing/);

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(lockIdx);
    expect(insertIdx).toBeGreaterThan(updateIdx);

    const update = sqlText(updateIdx);
    expect(update).toContain('provider =');
    expect(update).toContain('model =');
    expect(update).toContain('metric IS NULL');
    expect(update).toContain('effective_from <');
    expect(update).toContain('effective_to IS NULL OR effective_to >');
  });

  it('closes previous metric rows using the metric key only', async () => {
    const res = await POST(makeRequest(metricBody()));
    expect(res.status).toBe(201);

    const updateIdx = firstIndexMatching(/UPDATE custom_pricing/, /effective_from </);
    const update = sqlText(updateIdx);

    expect(update).toContain('metric =');
    expect(update).toContain('effective_to IS NULL OR effective_to >');
    expect(update).not.toContain('provider =');
    expect(update).not.toContain('model =');
  });

  it('auto-bounds a backdated insert to the next later version', async () => {
    mocks.nextVersionRows = [{ effective_from: '2026-06-15T00:00:00.000Z' }];

    const res = await POST(
      makeRequest(
        llmBody({
          effective_from: '2026-06-01T00:00:00.000Z',
        }),
      ),
    );
    expect(res.status).toBe(201);

    const insert = sqlText(firstIndexMatching(/INSERT INTO custom_pricing/));
    expect(insert).toContain('2026-06-15T00:00:00.000Z');
  });

  it('rejects invalid explicit intervals before touching the database', async () => {
    const res = await POST(
      makeRequest(
        llmBody({
          effective_to: '2026-06-19T00:00:00.000Z',
        }),
      ),
    );

    expect(res.status).toBe(400);
    expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects explicit intervals that overlap the next later version', async () => {
    mocks.nextVersionRows = [{ effective_from: '2026-06-15T00:00:00.000Z' }];

    const res = await POST(
      makeRequest(
        llmBody({
          effective_from: '2026-06-01T00:00:00.000Z',
          effective_to: '2026-06-16T00:00:00.000Z',
        }),
      ),
    );

    expect(res.status).toBe(409);
    expect(firstIndexMatching(/INSERT INTO custom_pricing/)).toBe(-1);
  });
});

describe('PATCH /api/v1/custom-pricing interval edits', () => {
  it('rejects an effective_to before the row effective_from', async () => {
    mocks.patchRow = patchRow();

    const res = await PATCH(
      makeRequest({
        id: PATCH_ID,
        effective_to: '2026-05-31T00:00:00.000Z',
      }),
    );

    expect(res.status).toBe(400);
    expect(firstIndexMatching(/UPDATE custom_pricing/, /RETURNING id/)).toBe(-1);
  });

  it('rejects extending a row past the next later version', async () => {
    mocks.patchRow = patchRow();
    mocks.nextVersionRows = [{ effective_from: '2026-06-15T00:00:00.000Z' }];

    const res = await PATCH(
      makeRequest({
        id: PATCH_ID,
        effective_to: '2026-06-16T00:00:00.000Z',
      }),
    );

    expect(res.status).toBe(409);
    expect(firstIndexMatching(/UPDATE custom_pricing/, /RETURNING id/)).toBe(-1);
  });

  it('rejects clearing effective_to when another open version already exists', async () => {
    mocks.patchRow = patchRow({ effective_to: '2026-06-10T00:00:00.000Z' });
    mocks.otherOpenRows = [{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }];

    const res = await PATCH(
      makeRequest({
        id: PATCH_ID,
        effective_to: null,
      }),
    );

    expect(res.status).toBe(409);
    expect(firstIndexMatching(/UPDATE custom_pricing/, /RETURNING id/)).toBe(-1);
  });

  it('scopes PATCH lookups and writes to the authenticated builder', async () => {
    mocks.patchRow = patchRow();

    const res = await PATCH(
      makeRequest({
        id: PATCH_ID,
        effective_to: '2026-06-12T00:00:00.000Z',
      }),
    );

    expect(res.status).toBe(200);
    const initialSelect = sqlText(firstIndexMatching(/FROM custom_pricing/, /WHERE id =/));
    const lockedSelect = sqlText(firstIndexMatching(/FOR UPDATE/));
    const update = sqlText(firstIndexMatching(/UPDATE custom_pricing/, /RETURNING id/));

    expect(initialSelect).toContain('builder_id =');
    expect(lockedSelect).toContain('builder_id =');
    expect(update).toContain('builder_id =');
  });
});

describe('GET / DELETE /api/v1/custom-pricing tenant scope', () => {
  it('scopes list reads to the authenticated builder', async () => {
    const res = await GET(makeRequest({}));

    expect(res.status).toBe(200);
    const listQuery = sqlText(firstIndexMatching(/FROM custom_pricing/, /ORDER BY created_at DESC/));
    expect(listQuery).toContain('builder_id =');
  });

  it('scopes deletes to the authenticated builder', async () => {
    const res = await DELETE(makeRequest({ id: PATCH_ID }));

    expect(res.status).toBe(200);
    const deleteQuery = sqlText(firstIndexMatching(/DELETE FROM custom_pricing/, /RETURNING id/));
    expect(deleteQuery).toContain('builder_id =');
  });
});
