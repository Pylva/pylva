// Track 1 PR 1.2 — API key dashboard CRUD.
// Owner-only mutations (per §3 security defaults). Member read-only metadata
// per O18. Since migration 048 there is one universal key: every mint gets
// scope 'universal' and the body carries only an optional label. Legacy
// clients may still send `scope`/`confirm_email` — valibot strips unknown
// keys, so those bodies keep working and mint a universal key.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as Sentry from '@sentry/nextjs';
import * as v from 'valibot';
import { eq, isNull, and } from 'drizzle-orm';
import { ApiKeyScope, ErrorCode, type Role as RoleType } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { generateApiKeyWithClient } from '@/lib/auth/api-key';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { withRLS } from '@/lib/db/rls';
import { apiKeys } from '@/lib/db/schema';
import { hasPgErrorCode } from '@/lib/db/pg-error';
import { authError, internalError, validationError } from '@/lib/errors';

const CreateSchema = v.object({
  label: v.optional(v.pipe(v.string(), v.maxLength(100))),
});

const API_KEY_CREATE_ERROR = 'Could not create the API key. Please try again.';
const SCHEMA_OUT_OF_DATE_ERROR =
  'The database schema is out of date — a pending migration must be applied. Check /api/v1/health schema status, then run pnpm db:migrate.';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx
      .select({
        id: apiKeys.id,
        key_id: apiKeys.key_id,
        scope: apiKeys.scope,
        label: apiKeys.label,
        created_at: apiKeys.created_at,
        expires_at: apiKeys.expires_at,
        revoked_at: apiKeys.revoked_at,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.builder_id, ctx.builderId), isNull(apiKeys.revoked_at))),
  );
  return NextResponse.json({ keys: rows });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }
  const parsed = v.safeParse(CreateSchema, body);
  if (!parsed.success) return validationError(parsed.issues[0]?.message ?? 'Invalid body', 'body');

  let result: Awaited<ReturnType<typeof generateApiKeyWithClient>>;
  try {
    result = await withRLS(ctx.builderId, async (tx) => {
      const createdKey = await generateApiKeyWithClient(tx, ctx.builderId, parsed.output.label);
      await auditLog(tx, {
        builder_id: ctx.builderId,
        actor_type: 'user',
        actor_id: ctx.userId!,
        action: AuditAction.API_KEY_CREATE,
        resource_type: 'api_key',
        resource_id: createdKey.keyId,
        details: { scope: ApiKeyScope.UNIVERSAL, label: parsed.output.label ?? null },
      });
      return createdKey;
    });
  } catch (error) {
    Sentry.captureException(error);
    return internalError(
      hasPgErrorCode(error, '23514') ? SCHEMA_OUT_OF_DATE_ERROR : API_KEY_CREATE_ERROR,
    );
  }

  // Plaintext is returned exactly once. Never persisted in cache after this.
  // `scope` stays in the response shape so stale dashboard bundles render a
  // string instead of undefined.
  return NextResponse.json(
    {
      key: {
        key_id: result.keyId,
        plaintext: result.plaintextKey,
        scope: ApiKeyScope.UNIVERSAL,
        label: parsed.output.label ?? null,
      },
    },
    { status: 201 },
  );
}
