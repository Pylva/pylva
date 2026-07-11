import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextResponse } from 'next/server.js';
import { ApiKeyScope, ErrorCode } from '@pylva/shared';
import { assertWithRlsCallbacksUseTransactionOnly } from '../_helpers/rls-discipline.js';

const routeMocks = vi.hoisted(() => ({
  auditLog: vi.fn(),
  captureException: vi.fn(),
  generateApiKey: vi.fn(),
  revokeApiKey: vi.fn(),
  keyRows: [{ key_id: 'universal-key', scope: 'universal' }],
  ctx: {
    builderId: '00000000-0000-4000-8000-000000000001',
    role: 'owner',
    userId: 'user-1',
  },
  withRLS: vi.fn(),
  withRole: vi.fn(),
}));

vi.mock('@/lib/auth/builder-context', () => ({
  readBuilderContextFromDashboard: () => ({ ...routeMocks.ctx }),
}));

vi.mock('@/lib/auth/middleware', () => ({
  Role: { MEMBER: 'member', OWNER: 'owner' },
  withRole: routeMocks.withRole,
}));

vi.mock('@/lib/auth/api-key', () => ({
  generateApiKey: routeMocks.generateApiKey,
  generateApiKeyWithClient: routeMocks.generateApiKey,
  revokeApiKey: routeMocks.revokeApiKey,
}));

vi.mock('@/lib/auth/audit-log', () => ({
  auditLog: routeMocks.auditLog,
}));

vi.mock('@sentry/nextjs', () => ({
  captureException: routeMocks.captureException,
}));

vi.mock('@/lib/db/rls', () => ({
  withRLS: routeMocks.withRLS,
}));

const { GET, POST } = await import('../../src/app/api/v1/settings/api-keys/route.js');
const { DELETE } = await import('../../src/app/api/v1/settings/api-keys/[id]/route.js');

function makeRequest(body: unknown) {
  return new Request('http://localhost/api/v1/settings/api-keys', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  }) as unknown as import('next/server.js').NextRequest;
}

function makeRawRequest(body?: string) {
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  };
  if (body !== undefined) init.body = body;
  return new Request(
    'http://localhost/api/v1/settings/api-keys',
    init,
  ) as unknown as import('next/server.js').NextRequest;
}

function makeDeleteRequest() {
  return new Request(
    'http://localhost/api/v1/settings/api-keys/00000000-0000-4000-8000-000000000010',
    { method: 'DELETE' },
  ) as unknown as import('next/server.js').NextRequest;
}

function forbiddenResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: 'INSUFFICIENT_PERMISSIONS', message: 'Only owner can perform this action' } },
    { status: 403 },
  );
}

function rlsTxWithKeyRows() {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => routeMocks.keyRows,
        }),
      }),
    }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.ctx.builderId = '00000000-0000-4000-8000-000000000001';
  routeMocks.ctx.role = 'owner';
  routeMocks.ctx.userId = 'user-1';
  routeMocks.keyRows = [{ key_id: 'universal-key', scope: ApiKeyScope.UNIVERSAL }];
  routeMocks.withRole.mockReturnValue(null);
  routeMocks.withRLS.mockImplementation(async (_builderId: string, cb: (tx: unknown) => unknown) =>
    cb({}),
  );
  routeMocks.auditLog.mockResolvedValue(undefined);
  routeMocks.generateApiKey.mockImplementation(
    async (_tx: unknown, _builderId: string, _label?: string) => ({
      keyId: 'universal-key',
      plaintextKey: 'universal-plaintext',
    }),
  );
});

describe('POST failure hardening', () => {
  const genericMessage = 'Could not create the API key. Please try again.';
  const schemaMessage =
    'The database schema is out of date — a pending migration must be applied. Check /api/v1/health schema status, then run pnpm db:migrate.';

  it('returns a generic 500 envelope when generateApiKey rejects', async () => {
    const mintError = new Error('database exploded with pv_live_secret plaintext constraint');
    routeMocks.generateApiKey.mockRejectedValueOnce(mintError);

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: genericMessage,
      },
    });
    expect(body.error.message).not.toContain('database exploded');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('plaintext');
    expect(serialized).not.toContain('pv_live');
    expect(routeMocks.captureException).toHaveBeenCalledTimes(1);
    expect(routeMocks.captureException).toHaveBeenCalledWith(mintError);
    expect(routeMocks.auditLog).not.toHaveBeenCalled();
  });

  it('returns the schema migration message for SQLSTATE 23514', async () => {
    routeMocks.generateApiKey.mockRejectedValueOnce({ code: '23514' });

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe(schemaMessage);
    expect(body.error.message).toMatch(/schema/i);
    expect(body.error.message).toMatch(/migration/i);
    expect(routeMocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('returns the schema migration message for nested cause SQLSTATE 23514', async () => {
    const mintError = new Error('wrapped');
    mintError.cause = { code: '23514' };
    routeMocks.generateApiKey.mockRejectedValueOnce(mintError);

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe(schemaMessage);
    expect(body.error.message).toMatch(/schema/i);
    expect(body.error.message).toMatch(/migration/i);
    expect(routeMocks.captureException).toHaveBeenCalledWith(mintError);
  });

  it('keys the 23514 message only on SQLSTATE, not the constraint name', async () => {
    routeMocks.generateApiKey.mockRejectedValueOnce({
      code: '23514',
      constraint_name: 'audit_log_y2026m07_check',
      message: 'new row violates check constraint',
    });

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe(schemaMessage);
    expect(body.error.message).not.toContain('audit_log_y2026m07_check');
  });

  it('returns a 500 and no plaintext when audit logging fails inside the create transaction', async () => {
    const auditError = new Error('audit partition missing');
    const tx = { transaction: 'api-key-create' };
    routeMocks.withRLS.mockImplementationOnce(
      async (_builderId: string, cb: (tx: unknown) => unknown) => cb(tx),
    );
    routeMocks.auditLog.mockRejectedValueOnce(auditError);

    const response = await POST(makeRequest({ label: 'Production SDK' }));

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toEqual({
      error: {
        type: 'api_error',
        code: ErrorCode.INTERNAL_ERROR,
        message: genericMessage,
      },
    });
    expect(JSON.stringify(body)).not.toContain('universal-plaintext');
    expect(routeMocks.generateApiKey).toHaveBeenCalledWith(
      tx,
      routeMocks.ctx.builderId,
      'Production SDK',
    );
    expect(routeMocks.auditLog).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        builder_id: routeMocks.ctx.builderId,
        actor_id: routeMocks.ctx.userId,
        action: 'api_key.create',
        resource_id: 'universal-key',
      }),
    );
    expect(routeMocks.captureException).toHaveBeenCalledWith(auditError);
    expect(routeMocks.generateApiKey).toHaveBeenCalledTimes(1);
  });
});

describe('POST /api/v1/settings/api-keys', () => {
  it('creates a universal key with an optional label', async () => {
    const response = await POST(makeRequest({ label: 'Production SDK' }));

    expect(response.status).toBe(201);
    expect(routeMocks.generateApiKey).toHaveBeenCalledWith(
      {},
      routeMocks.ctx.builderId,
      'Production SDK',
    );
    await expect(response.json()).resolves.toMatchObject({
      key: {
        key_id: 'universal-key',
        plaintext: 'universal-plaintext',
        scope: ApiKeyScope.UNIVERSAL,
        label: 'Production SDK',
      },
    });
    expect(routeMocks.auditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        builder_id: routeMocks.ctx.builderId,
        actor_id: routeMocks.ctx.userId,
        action: 'api_key.create',
        resource_id: 'universal-key',
        details: { scope: ApiKeyScope.UNIVERSAL, label: 'Production SDK' },
      }),
    );
  });

  it('creates a universal key from an empty body', async () => {
    const response = await POST(makeRequest({}));

    expect(response.status).toBe(201);
    expect(routeMocks.generateApiKey).toHaveBeenCalledWith(
      {},
      routeMocks.ctx.builderId,
      undefined,
    );
    await expect(response.json()).resolves.toMatchObject({
      key: {
        scope: ApiKeyScope.UNIVERSAL,
        label: null,
      },
    });
  });

  // Legacy dashboard bundles may still send scope/confirm_email. The schema
  // strips unknown keys, so those bodies mint a universal key — including
  // admin_api WITHOUT confirm_email, which used to 403 STEP_UP_REQUIRED.
  // That behavior change is the intentional removal of the step-up gate.
  it.each([
    [{ scope: ApiKeyScope.AGENT_SDK }],
    [{ scope: ApiKeyScope.ADMIN_API }],
    [{ scope: ApiKeyScope.DATA_IMPORT, label: 'importer' }],
    [{ scope: 'telemetry' }],
    [{ scope: 'not_a_scope' }],
    [{ scope: ApiKeyScope.ADMIN_API, confirm_email: 'anything@example.com' }],
  ])('ignores legacy body fields and mints a universal key: %j', async (body) => {
    const response = await POST(makeRequest(body));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      key: { scope: ApiKeyScope.UNIVERSAL },
    });
  });

  it('returns 400 for an over-long label', async () => {
    const response = await POST(makeRequest({ label: 'x'.repeat(101) }));

    expect(response.status).toBe(400);
    expect(routeMocks.generateApiKey).not.toHaveBeenCalled();
  });

  it('returns 400 for empty and malformed JSON bodies', async () => {
    for (const request of [makeRawRequest(), makeRawRequest('{')]) {
      const response = await POST(request);

      expect(response.status).toBe(400);
    }
    expect(routeMocks.generateApiKey).not.toHaveBeenCalled();
  });

  it('returns 403 for member create attempts before generating a key', async () => {
    routeMocks.ctx.role = 'member';
    routeMocks.withRole.mockReturnValue(forbiddenResponse());

    const response = await POST(makeRequest({}));

    expect(response.status).toBe(403);
    expect(routeMocks.generateApiKey).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/settings/api-keys/[id]', () => {
  it('returns 403 for member revoke attempts before revoking a key', async () => {
    routeMocks.ctx.role = 'member';
    routeMocks.withRole.mockReturnValue(forbiddenResponse());

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000010' }),
    });

    expect(response.status).toBe(403);
    expect(routeMocks.revokeApiKey).not.toHaveBeenCalled();
  });

  it('allows owner revoke attempts and writes an audit entry', async () => {
    routeMocks.withRLS
      .mockImplementationOnce(async (_builderId: string, cb: (tx: unknown) => unknown) =>
        cb(rlsTxWithKeyRows()),
      )
      .mockImplementationOnce(async (_builderId: string, cb: (tx: unknown) => unknown) => cb({}));

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000010' }),
    });

    expect(response.status).toBe(200);
    expect(routeMocks.revokeApiKey).toHaveBeenCalledWith('universal-key', true);
    expect(routeMocks.auditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        builder_id: routeMocks.ctx.builderId,
        actor_id: routeMocks.ctx.userId,
        action: 'api_key.revoke',
        resource_id: 'universal-key',
        details: { scope: ApiKeyScope.UNIVERSAL },
      }),
    );
  });

  it('audit-logs the persisted scope for a pre-046 straggler row on revoke', async () => {
    routeMocks.keyRows = [{ key_id: 'legacy-key', scope: 'agent_sdk' }];
    routeMocks.withRLS
      .mockImplementationOnce(async (_builderId: string, cb: (tx: unknown) => unknown) =>
        cb(rlsTxWithKeyRows()),
      )
      .mockImplementationOnce(async (_builderId: string, cb: (tx: unknown) => unknown) => cb({}));

    const response = await DELETE(makeDeleteRequest(), {
      params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000010' }),
    });

    expect(response.status).toBe(200);
    expect(routeMocks.revokeApiKey).toHaveBeenCalledWith('legacy-key', true);
    expect(routeMocks.auditLog).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        resource_id: 'legacy-key',
        details: { scope: 'agent_sdk' },
      }),
    );
  });
});

describe('GET /api/v1/settings/api-keys', () => {
  it('returns only metadata fields from the route-level projection', async () => {
    const listedRows = [
      {
        id: '00000000-0000-4000-8000-000000000010',
        key_id: 'universal-key',
        scope: ApiKeyScope.UNIVERSAL,
        label: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        expires_at: null,
        revoked_at: null,
      },
    ];
    routeMocks.withRLS.mockResolvedValueOnce(listedRows);

    const response = await GET(makeRawRequest());

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      keys: [
        {
          ...listedRows[0],
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });
});

describe('RLS discipline', () => {
  it('keeps API key route queries inside withRLS callbacks on tx, not global db', () => {
    for (const sourcePath of [
      fileURLToPath(new URL('../../src/app/api/v1/settings/api-keys/route.ts', import.meta.url)),
      fileURLToPath(
        new URL('../../src/app/api/v1/settings/api-keys/[id]/route.ts', import.meta.url),
      ),
    ]) {
      assertWithRlsCallbacksUseTransactionOnly(sourcePath);
    }
  });
});
