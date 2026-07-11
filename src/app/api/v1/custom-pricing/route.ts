// GET / POST / PATCH / DELETE /api/v1/custom-pricing.
// Auth: API key + Admin API scope (middleware).
// Every mutation writes an audit_log row.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { sql as drizzleSql } from 'drizzle-orm';
import { ErrorCode, modelSchema, providerSchema } from '@pylva/shared';
import { withRLS, type DrizzleTransaction } from '../../../../lib/db/rls.js';
import { unwrapRows } from '../../../../lib/db/query-utils.js';
import { auditLog } from '../../../../lib/auth/audit-log.js';
import { AuditAction } from '../../../../lib/audit/actions.js';
import { readBuilderContext } from '../../../../lib/auth/builder-context.js';
import {
  apiError,
  internalError,
  validationError,
  valibotFirstIssue,
} from '../../../../lib/errors.js';
import { logger } from '../../../../lib/logger.js';

const log = logger.child({ module: 'custom-pricing' });

const MAX_LIST_ROWS = 500;

const PricingSourceSchema = v.picklist(['builder_manual', 'admin_override']);

const BaseFieldsSchema = v.object({
  provider: v.nullable(providerSchema),
  model: v.nullable(modelSchema),
  metric: v.nullable(v.pipe(v.string(), v.maxLength(200))),
  price_per_unit_usd: v.pipe(v.number(), v.minValue(0)),
  input_per_1m_usd: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  output_per_1m_usd: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  effective_from: v.pipe(v.string(), v.isoTimestamp()),
  effective_to: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
  source: v.optional(PricingSourceSchema, 'builder_manual'),
  notes: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
});

const CreateSchema = v.pipe(
  BaseFieldsSchema,
  v.check((input) => {
    const hasLlm = input.provider != null && input.model != null && input.metric == null;
    const hasMetric = input.provider == null && input.model == null && input.metric != null;
    return hasLlm || hasMetric;
  }, 'Either (provider + model) or metric must be set, not both'),
);

const PatchSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
  price_per_unit_usd: v.optional(v.pipe(v.number(), v.minValue(0))),
  input_per_1m_usd: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  output_per_1m_usd: v.optional(v.nullable(v.pipe(v.number(), v.minValue(0)))),
  effective_to: v.optional(v.nullable(v.pipe(v.string(), v.isoTimestamp()))),
  notes: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(2000)))),
});

const DeleteSchema = v.object({
  id: v.pipe(v.string(), v.uuid()),
});

type CustomPricingRow = {
  id: string;
  provider: string | null;
  model: string | null;
  metric: string | null;
  price_per_unit_usd: string;
  input_per_1m_usd: string | null;
  output_per_1m_usd: string | null;
  effective_from: Date | string;
  effective_to: Date | string | null;
  source: string;
  notes: string | null;
  created_at: Date | string;
  updated_at: Date | string;
} & Record<string, unknown>;

type CreateInput = v.InferOutput<typeof CreateSchema>;

type CustomPricingKey =
  | { kind: 'llm'; provider: string; model: string }
  | { kind: 'metric'; metric: string };

type CustomPricingIdentityRow = {
  id: string;
  provider: string | null;
  model: string | null;
  metric: string | null;
  effective_from: Date | string;
  effective_to: Date | string | null;
};

type CustomPricingPatchRow = CustomPricingIdentityRow & {
  price_per_unit_usd: string;
  input_per_1m_usd: string | null;
  output_per_1m_usd: string | null;
  notes: string | null;
};

type NextVersionRow = {
  effective_from: Date | string;
};

type OpenVersionRow = {
  id: string;
};

type PreviousOverlapRow = {
  price_per_unit_usd: string;
  input_per_1m_usd: string | null;
  output_per_1m_usd: string | null;
  source: string;
  notes: string | null;
  effective_to: Date | string | null;
};

class CustomPricingIntervalError extends Error {
  constructor(
    message: string,
    readonly kind: 'validation' | 'conflict',
    readonly param = 'effective_to',
  ) {
    super(message);
  }
}

function createKey(input: CreateInput): CustomPricingKey {
  if (input.metric != null) return { kind: 'metric', metric: input.metric };
  return { kind: 'llm', provider: input.provider!, model: input.model! };
}

function rowKey(row: CustomPricingIdentityRow): CustomPricingKey {
  if (row.metric != null) return { kind: 'metric', metric: row.metric };
  return { kind: 'llm', provider: row.provider!, model: row.model! };
}

function lockKey(builderId: string, key: CustomPricingKey): string {
  if (key.kind === 'metric') return `custom_pricing:${builderId}:metric:${key.metric}`;
  return `custom_pricing:${builderId}:llm:${key.provider}:${key.model}`;
}

async function lockPricingKey(
  tx: DrizzleTransaction,
  builderId: string,
  key: CustomPricingKey,
): Promise<void> {
  await tx.execute(drizzleSql`
    SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(builderId, key)}, 0))
  `);
}

function assertValidInterval(
  effectiveFrom: Date | string,
  effectiveTo: Date | string | null | undefined,
): void {
  if (effectiveTo == null) return;
  if (new Date(effectiveTo).getTime() <= new Date(effectiveFrom).getTime()) {
    throw new CustomPricingIntervalError(
      '`effective_to` must be after `effective_from`',
      'validation',
      'effective_to',
    );
  }
}

function assertNoLaterOverlap(
  effectiveTo: Date | string | null | undefined,
  nextVersion: NextVersionRow | null,
): void {
  if (effectiveTo == null || nextVersion == null) return;
  if (new Date(effectiveTo).getTime() > new Date(nextVersion.effective_from).getTime()) {
    throw new CustomPricingIntervalError(
      '`effective_to` overlaps a later custom_pricing version for the same key',
      'conflict',
    );
  }
}

async function findNextVersion(
  tx: DrizzleTransaction,
  builderId: string,
  key: CustomPricingKey,
  effectiveFrom: Date | string,
  excludeId?: string,
): Promise<NextVersionRow | null> {
  const idFilter = excludeId ? drizzleSql`AND id <> ${excludeId}::uuid` : drizzleSql``;
  const result =
    key.kind === 'metric'
      ? await tx.execute<NextVersionRow>(drizzleSql`
          SELECT effective_from
          FROM custom_pricing
          WHERE builder_id = ${builderId}::uuid
            AND metric = ${key.metric}
            ${idFilter}
            AND effective_from > ${effectiveFrom}::timestamptz
          ORDER BY effective_from ASC
          LIMIT 1
        `)
      : await tx.execute<NextVersionRow>(drizzleSql`
          SELECT effective_from
          FROM custom_pricing
          WHERE builder_id = ${builderId}::uuid
            AND provider = ${key.provider}
            AND model = ${key.model}
            AND metric IS NULL
            ${idFilter}
            AND effective_from > ${effectiveFrom}::timestamptz
          ORDER BY effective_from ASC
          LIMIT 1
        `);
  return unwrapRows<NextVersionRow>(result)[0] ?? null;
}

async function findOtherOpenVersion(
  tx: DrizzleTransaction,
  builderId: string,
  key: CustomPricingKey,
  excludeId: string,
): Promise<OpenVersionRow | null> {
  const result =
    key.kind === 'metric'
      ? await tx.execute<OpenVersionRow>(drizzleSql`
          SELECT id
          FROM custom_pricing
          WHERE builder_id = ${builderId}::uuid
            AND metric = ${key.metric}
            AND id <> ${excludeId}::uuid
            AND effective_to IS NULL
          LIMIT 1
        `)
      : await tx.execute<OpenVersionRow>(drizzleSql`
          SELECT id
          FROM custom_pricing
          WHERE builder_id = ${builderId}::uuid
            AND provider = ${key.provider}
            AND model = ${key.model}
            AND metric IS NULL
            AND id <> ${excludeId}::uuid
            AND effective_to IS NULL
          LIMIT 1
        `);
  return unwrapRows<OpenVersionRow>(result)[0] ?? null;
}

// The single existing row whose [effective_from, effective_to) interval covers
// the instant `effectiveFrom` (intervals are non-overlapping, so there is at
// most one). Returned with its price fields + original end so a bounded insert
// can re-open the tail that closePreviousOverlap truncates away.
async function findPreviousOverlap(
  tx: DrizzleTransaction,
  builderId: string,
  key: CustomPricingKey,
  effectiveFrom: Date | string,
): Promise<PreviousOverlapRow | null> {
  const result =
    key.kind === 'metric'
      ? await tx.execute<PreviousOverlapRow>(drizzleSql`
          SELECT price_per_unit_usd::text AS price_per_unit_usd,
                 input_per_1m_usd::text AS input_per_1m_usd,
                 output_per_1m_usd::text AS output_per_1m_usd,
                 source, notes, effective_to
          FROM custom_pricing
          WHERE builder_id = ${builderId}::uuid
            AND metric = ${key.metric}
            AND effective_from < ${effectiveFrom}::timestamptz
            AND (effective_to IS NULL OR effective_to > ${effectiveFrom}::timestamptz)
          ORDER BY effective_from DESC
          LIMIT 1
        `)
      : await tx.execute<PreviousOverlapRow>(drizzleSql`
          SELECT price_per_unit_usd::text AS price_per_unit_usd,
                 input_per_1m_usd::text AS input_per_1m_usd,
                 output_per_1m_usd::text AS output_per_1m_usd,
                 source, notes, effective_to
          FROM custom_pricing
          WHERE builder_id = ${builderId}::uuid
            AND provider = ${key.provider}
            AND model = ${key.model}
            AND metric IS NULL
            AND effective_from < ${effectiveFrom}::timestamptz
            AND (effective_to IS NULL OR effective_to > ${effectiveFrom}::timestamptz)
          ORDER BY effective_from DESC
          LIMIT 1
        `);
  return unwrapRows<PreviousOverlapRow>(result)[0] ?? null;
}

async function closePreviousOverlap(
  tx: DrizzleTransaction,
  builderId: string,
  key: CustomPricingKey,
  effectiveFrom: Date | string,
): Promise<void> {
  if (key.kind === 'metric') {
    await tx.execute(drizzleSql`
      UPDATE custom_pricing
      SET effective_to = ${effectiveFrom}::timestamptz, updated_at = NOW()
      WHERE builder_id = ${builderId}::uuid
        AND metric = ${key.metric}
        AND effective_from < ${effectiveFrom}::timestamptz
        AND (effective_to IS NULL OR effective_to > ${effectiveFrom}::timestamptz)
    `);
    return;
  }

  await tx.execute(drizzleSql`
    UPDATE custom_pricing
    SET effective_to = ${effectiveFrom}::timestamptz, updated_at = NOW()
    WHERE builder_id = ${builderId}::uuid
      AND provider = ${key.provider}
      AND model = ${key.model}
      AND metric IS NULL
      AND effective_from < ${effectiveFrom}::timestamptz
      AND (effective_to IS NULL OR effective_to > ${effectiveFrom}::timestamptz)
  `);
}

function conflictError(message: string): NextResponse {
  return apiError(409, 'invalid_request_error', ErrorCode.VALIDATION_ERROR, message);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const { builderId } = ctx;

  try {
    const rows = await withRLS(builderId, async (tx) => {
      const result = await tx.execute<CustomPricingRow>(drizzleSql`
        SELECT id, provider, model, metric,
               price_per_unit_usd::text AS price_per_unit_usd,
               input_per_1m_usd::text AS input_per_1m_usd,
               output_per_1m_usd::text AS output_per_1m_usd,
               effective_from, effective_to, source, notes,
               created_at, updated_at
        FROM custom_pricing
        WHERE builder_id = ${builderId}::uuid
        ORDER BY created_at DESC
        LIMIT ${MAX_LIST_ROWS}
      `);
      return unwrapRows<CustomPricingRow>(result);
    });

    const entries = rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      model: r.model,
      metric: r.metric,
      price_per_unit_usd: Number(r.price_per_unit_usd),
      input_per_1m_usd: r.input_per_1m_usd == null ? null : Number(r.input_per_1m_usd),
      output_per_1m_usd: r.output_per_1m_usd == null ? null : Number(r.output_per_1m_usd),
      effective_from: new Date(r.effective_from).toISOString(),
      effective_to: r.effective_to == null ? null : new Date(r.effective_to).toISOString(),
      source: r.source,
      notes: r.notes,
      created_at: new Date(r.created_at).toISOString(),
      updated_at: new Date(r.updated_at).toISOString(),
    }));

    return NextResponse.json({ entries }, { status: 200 });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err), builder_id: builderId },
      'custom-pricing GET failed',
    );
    return internalError('failed to read custom_pricing');
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const { builderId, keyId } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(CreateSchema, body);
  if (!parsed.success) {
    const { message, param } = valibotFirstIssue(parsed.issues);
    return validationError(message, param);
  }
  const input = parsed.output;

  try {
    assertValidInterval(input.effective_from, input.effective_to);

    const newId = await withRLS(builderId, async (tx) => {
      const key = createKey(input);
      await lockPricingKey(tx, builderId, key);

      const nextVersion = await findNextVersion(tx, builderId, key, input.effective_from);
      assertNoLaterOverlap(input.effective_to, nextVersion);

      // Keep custom_pricing intervals non-overlapping for both forward
      // corrections and backdated historical inserts. Backdated inserts are
      // bounded to the next later row; forward inserts truncate the previous
      // overlapping row at the new start.
      //
      // A bounded insert ([effective_from, effective_to) with an explicit
      // effective_to) into an existing interval must also preserve that
      // interval's tail: closePreviousOverlap only truncates the overlapped row
      // at effective_from, so without re-opening [effective_to, priorEnd) the
      // previously-active price silently vanishes after the bounded window and
      // later usage falls through to needs_input (metric) or the public catalog
      // rate (LLM). Snapshot the overlapped row before truncating it.
      const priorOverlap =
        input.effective_to != null
          ? await findPreviousOverlap(tx, builderId, key, input.effective_from)
          : null;

      await closePreviousOverlap(tx, builderId, key, input.effective_from);
      const insertEffectiveTo = input.effective_to ?? nextVersion?.effective_from ?? null;

      const result = await tx.execute<{ id: string }>(drizzleSql`
        INSERT INTO custom_pricing (
          builder_id, provider, model, metric,
          price_per_unit_usd, input_per_1m_usd, output_per_1m_usd,
          effective_from, effective_to, source, notes
        ) VALUES (
          ${builderId}::uuid,
          ${input.provider},
          ${input.model},
          ${input.metric},
          ${input.price_per_unit_usd},
          ${input.input_per_1m_usd ?? null},
          ${input.output_per_1m_usd ?? null},
          ${input.effective_from}::timestamptz,
          ${insertEffectiveTo}::timestamptz,
          ${input.source},
          ${input.notes ?? null}
        )
        RETURNING id
      `);
      const row = unwrapRows<{ id: string }>(result)[0];
      if (!row) throw new Error('insert returned no row');

      // Re-open the tail of the truncated prior interval when it extended past
      // the new bounded row, i.e. its original end was open (NULL) or strictly
      // after effective_to. This restores [effective_to, priorEnd) at the prior
      // price so usage after the bounded window stays billed at the price the
      // builder had in effect. When effective_to matches the next version (or
      // the prior row already ended by then) priorEnd <= effective_to, so no
      // continuation is written and the (provider, model, effective_from) /
      // (metric, effective_from) uniqueness cannot collide.
      if (
        input.effective_to != null &&
        priorOverlap != null &&
        (priorOverlap.effective_to == null ||
          new Date(priorOverlap.effective_to).getTime() > new Date(input.effective_to).getTime())
      ) {
        await tx.execute(drizzleSql`
          INSERT INTO custom_pricing (
            builder_id, provider, model, metric,
            price_per_unit_usd, input_per_1m_usd, output_per_1m_usd,
            effective_from, effective_to, source, notes
          ) VALUES (
            ${builderId}::uuid,
            ${input.provider},
            ${input.model},
            ${input.metric},
            ${priorOverlap.price_per_unit_usd}::numeric,
            ${priorOverlap.input_per_1m_usd}::numeric,
            ${priorOverlap.output_per_1m_usd}::numeric,
            ${input.effective_to}::timestamptz,
            ${
              priorOverlap.effective_to == null
                ? null
                : new Date(priorOverlap.effective_to).toISOString()
            }::timestamptz,
            ${priorOverlap.source},
            ${priorOverlap.notes}
          )
        `);
      }

      await auditLog(tx, {
        builder_id: builderId,
        actor_type: 'api_key',
        actor_id: keyId,
        action: AuditAction.CUSTOM_PRICING_CREATE,
        resource_type: 'custom_pricing',
        resource_id: row.id,
        details: {
          provider: input.provider,
          model: input.model,
          metric: input.metric,
          price_per_unit_usd: input.price_per_unit_usd,
          effective_from: input.effective_from,
          source: input.source,
        },
      });

      return row.id;
    });

    return NextResponse.json({ id: newId }, { status: 201 });
  } catch (err) {
    if (err instanceof CustomPricingIntervalError) {
      if (err.kind === 'validation') return validationError(err.message, err.param);
      return conflictError(err.message);
    }

    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
      return apiError(
        409,
        'invalid_request_error',
        ErrorCode.VALIDATION_ERROR,
        'A custom_pricing row already exists for this (provider, model, effective_from) or (metric, effective_from).',
      );
    }
    log.error({ error: msg, builder_id: builderId }, 'custom-pricing POST failed');
    return internalError('failed to create custom_pricing');
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const { builderId, keyId } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(PatchSchema, body);
  if (!parsed.success) {
    const { message, param } = valibotFirstIssue(parsed.issues);
    return validationError(message, param);
  }
  const input = parsed.output;

  try {
    const updated = await withRLS(builderId, async (tx) => {
      let beforeResult = await tx.execute<CustomPricingPatchRow>(drizzleSql`
        SELECT id, provider, model, metric,
               price_per_unit_usd::text AS price_per_unit_usd,
               input_per_1m_usd::text AS input_per_1m_usd,
               output_per_1m_usd::text AS output_per_1m_usd,
               effective_from, effective_to, notes
        FROM custom_pricing
        WHERE id = ${input.id}::uuid
          AND builder_id = ${builderId}::uuid
      `);
      let before = unwrapRows<CustomPricingPatchRow>(beforeResult)[0];
      if (!before) return false;

      if (input.effective_to !== undefined) {
        const key = rowKey(before);
        await lockPricingKey(tx, builderId, key);

        beforeResult = await tx.execute<CustomPricingPatchRow>(drizzleSql`
          SELECT id, provider, model, metric,
                 price_per_unit_usd::text AS price_per_unit_usd,
                 input_per_1m_usd::text AS input_per_1m_usd,
                 output_per_1m_usd::text AS output_per_1m_usd,
                 effective_from, effective_to, notes
          FROM custom_pricing
          WHERE id = ${input.id}::uuid
            AND builder_id = ${builderId}::uuid
          FOR UPDATE
        `);
        before = unwrapRows<CustomPricingPatchRow>(beforeResult)[0];
        if (!before) return false;

        const lockedKey = rowKey(before);
        assertValidInterval(before.effective_from, input.effective_to);

        const nextVersion = await findNextVersion(
          tx,
          builderId,
          lockedKey,
          before.effective_from,
          input.id,
        );
        if (input.effective_to === null) {
          if (nextVersion != null) {
            throw new CustomPricingIntervalError(
              '`effective_to` cannot be cleared while a later custom_pricing version exists for the same key',
              'conflict',
            );
          }
          const otherOpen = await findOtherOpenVersion(tx, builderId, lockedKey, input.id);
          if (otherOpen != null) {
            throw new CustomPricingIntervalError(
              '`effective_to` cannot be cleared because another open custom_pricing version exists for the same key',
              'conflict',
            );
          }
        } else {
          assertNoLaterOverlap(input.effective_to, nextVersion);
        }
      }

      // CASE WHEN ${undefined} THEN col ELSE newValue END preserves the column
      // when the key is absent from the PATCH body, while still allowing explicit
      // nulls to be written through (effective_to: null cancels a scheduled end).
      const updateResult = await tx.execute(drizzleSql`
        UPDATE custom_pricing
        SET
          price_per_unit_usd = COALESCE(${input.price_per_unit_usd ?? null}, price_per_unit_usd),
          input_per_1m_usd   = CASE WHEN ${input.input_per_1m_usd === undefined} THEN input_per_1m_usd ELSE ${input.input_per_1m_usd ?? null} END,
          output_per_1m_usd  = CASE WHEN ${input.output_per_1m_usd === undefined} THEN output_per_1m_usd ELSE ${input.output_per_1m_usd ?? null} END,
          effective_to       = CASE WHEN ${input.effective_to === undefined} THEN effective_to ELSE ${input.effective_to ?? null}::timestamptz END,
          notes              = CASE WHEN ${input.notes === undefined} THEN notes ELSE ${input.notes ?? null} END,
          updated_at         = NOW()
        WHERE id = ${input.id}::uuid
          AND builder_id = ${builderId}::uuid
        RETURNING id
      `);
      if (unwrapRows(updateResult).length === 0) return false;

      await auditLog(tx, {
        builder_id: builderId,
        actor_type: 'api_key',
        actor_id: keyId,
        action: AuditAction.CUSTOM_PRICING_UPDATE,
        resource_type: 'custom_pricing',
        resource_id: input.id,
        details: { before, after: input },
      });

      return true;
    });

    if (!updated) {
      return apiError(
        404,
        'invalid_request_error',
        ErrorCode.VALIDATION_ERROR,
        'custom_pricing row not found',
      );
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    if (err instanceof CustomPricingIntervalError) {
      if (err.kind === 'validation') return validationError(err.message, err.param);
      return conflictError(err.message);
    }

    log.error(
      { error: err instanceof Error ? err.message : String(err), builder_id: builderId },
      'custom-pricing PATCH failed',
    );
    return internalError('failed to update custom_pricing');
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const { builderId, keyId } = ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(DeleteSchema, body);
  if (!parsed.success) {
    const { message, param } = valibotFirstIssue(parsed.issues);
    return validationError(message, param);
  }
  const input = parsed.output;

  try {
    const existed = await withRLS(builderId, async (tx) => {
      const result = await tx.execute<{ id: string }>(drizzleSql`
        DELETE FROM custom_pricing
        WHERE id = ${input.id}::uuid
          AND builder_id = ${builderId}::uuid
        RETURNING id
      `);
      if (unwrapRows(result).length === 0) return false;

      await auditLog(tx, {
        builder_id: builderId,
        actor_type: 'api_key',
        actor_id: keyId,
        action: AuditAction.CUSTOM_PRICING_DELETE,
        resource_type: 'custom_pricing',
        resource_id: input.id,
      });

      return true;
    });

    if (!existed) {
      return apiError(
        404,
        'invalid_request_error',
        ErrorCode.VALIDATION_ERROR,
        'custom_pricing row not found',
      );
    }
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : String(err), builder_id: builderId },
      'custom-pricing DELETE failed',
    );
    return internalError('failed to delete custom_pricing');
  }
}
