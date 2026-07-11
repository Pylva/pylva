// B3-T4a — /api/v1/cost-sources CRUD
// Auth dispatch:
//   GET:       dashboard JWT (middleware sets x-builder-id).
//   PATCH:     dashboard JWT, Owner-only (pricing edits are owner-only).
//   POST:      either an API key (universal — sent as X-Pylva-Key or Bearer)
//              OR dashboard JWT. The dashboard JWT path is Owner-only
//              (creating a priced source is a pricing mutation); the
//              machine-key path is ungated. See src/middleware.ts.

import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { and, eq } from 'drizzle-orm';
import {
  CostSourceTrackingStatus,
  ErrorCode,
  type CostSourceRow,
  type CostSourceType,
  type CostSourceTrackingStatus as TrackingStatus,
  type PricingTier,
  type Role as RoleType,
} from '@pylva/shared';
import { readBuilderContext, readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRole, Role } from '@/lib/auth/middleware';
import { auditLog } from '@/lib/auth/audit-log';
import { AuditAction } from '@/lib/audit/actions';
import { costSources } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';
import { authError, validationError } from '@/lib/errors';

const sourceTypeSchema = v.picklist(['llm_provider', 'non_llm_manual']);
const nonNegativeNumberSchema = v.pipe(v.number(), v.minValue(0));

const pricingTierSchema = v.object({
  from: nonNegativeNumberSchema,
  to: v.union([nonNegativeNumberSchema, v.null()]),
  price: nonNegativeNumberSchema,
});

const createSchema = v.object({
  display_name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  slug: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/), v.maxLength(100)),
  source_type: sourceTypeSchema,
  metric: v.optional(v.pipe(v.string(), v.maxLength(100))),
  unit: v.optional(v.pipe(v.string(), v.maxLength(50))),
  price_per_unit: v.optional(nonNegativeNumberSchema),
  pricing_tiers: v.optional(v.array(pricingTierSchema)),
  tracking_status: v.optional(v.picklist(['tracked', 'ignored', 'pending'])),
  matchers: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(100)))),
  default_metric_value: v.optional(nonNegativeNumberSchema),
});

const patchSchema = v.object({
  display_name: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
  metric: v.optional(v.union([v.pipe(v.string(), v.maxLength(100)), v.null()])),
  unit: v.optional(v.union([v.pipe(v.string(), v.maxLength(50)), v.null()])),
  price_per_unit: v.optional(v.union([nonNegativeNumberSchema, v.null()])),
  pricing_tiers: v.optional(v.union([v.array(pricingTierSchema), v.null()])),
  tracking_status: v.optional(v.picklist(['tracked', 'ignored', 'pending'])),
  matchers: v.optional(v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(100)))),
  default_metric_value: v.optional(v.union([nonNegativeNumberSchema, v.null()])),
});

type CreateInput = v.InferOutput<typeof createSchema>;

function rowToCostSource(row: typeof costSources.$inferSelect): CostSourceRow {
  return {
    id: row.id,
    builder_id: row.builder_id,
    source_type: row.source_type as CostSourceType,
    display_name: row.display_name,
    slug: row.slug,
    metric: row.metric,
    unit: row.unit,
    price_per_unit: row.price_per_unit === null ? null : Number(row.price_per_unit),
    pricing_tiers: (row.pricing_tiers as PricingTier[] | null) ?? null,
    status: row.status as CostSourceRow['status'],
    tracking_status: (row.tracking_status ?? CostSourceTrackingStatus.TRACKED) as TrackingStatus,
    matchers: row.matchers ?? [],
    default_metric_value:
      row.default_metric_value === null || row.default_metric_value === undefined
        ? null
        : Number(row.default_metric_value),
    last_seen_at: row.last_seen_at,
    last_discovered_at: row.last_discovered_at ?? null,
    discovery_count: row.discovery_count ?? 0,
    approved_at: row.approved_at,
    created_at: row.created_at,
  };
}

function normalizeMatcher(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.:/-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100);
}

function normalizeMatchers(values: string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? [fallback]).map(normalizeMatcher).filter(Boolean);
  return Array.from(new Set(normalized));
}

function defaultMetricValueForCreate(
  input: CreateInput,
  trackingStatus: TrackingStatus,
): number | null {
  if (input.default_metric_value !== undefined) return input.default_metric_value;
  return input.source_type === 'non_llm_manual' &&
    trackingStatus === CostSourceTrackingStatus.TRACKED
    ? 1
    : null;
}

function hasPricing(input: {
  price_per_unit?: number | null;
  pricing_tiers?: PricingTier[] | null;
}): boolean {
  return (
    (input.price_per_unit !== undefined && input.price_per_unit !== null) ||
    (Array.isArray(input.pricing_tiers) && input.pricing_tiers.length > 0)
  );
}

function validateTrackable(input: {
  source_type: CostSourceType;
  tracking_status: TrackingStatus;
  metric?: string | null;
  unit?: string | null;
  matchers: string[];
  price_per_unit?: number | null;
  pricing_tiers?: PricingTier[] | null;
}): { ok: true } | { ok: false; message: string; param: string } {
  if (input.source_type !== 'non_llm_manual' || input.tracking_status !== 'tracked') {
    return { ok: true };
  }
  if (!input.metric)
    return { ok: false, message: 'metric is required to track a non-LLM source', param: 'metric' };
  if (!input.unit)
    return { ok: false, message: 'unit is required to track a non-LLM source', param: 'unit' };
  if (input.matchers.length === 0) {
    return {
      ok: false,
      message: 'at least one matcher is required to track a non-LLM source',
      param: 'matchers',
    };
  }
  if (!hasPricing(input)) {
    return {
      ok: false,
      message: 'pricing is required to track a non-LLM source',
      param: 'price_per_unit',
    };
  }
  return { ok: true };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const rows = await withRLS(ctx.builderId, async (tx) =>
    tx.select().from(costSources).where(eq(costSources.builder_id, ctx.builderId)),
  );
  return NextResponse.json({ cost_sources: rows.map(rowToCostSource) });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Auth dispatch (see middleware): an API-key caller sets x-key-id;
  // otherwise this is a dashboard JWT caller. Dashboard callers must be Owner —
  // creating a priced, approved cost source is a pricing mutation, and pricing
  // mutations are owner-only (see PATCH below, O18 + §3 security defaults:
  // "Members can read but not mutate cost-source rows"). The machine-key
  // path carries no user role and stays ungated for CLI discovery.
  let builderId: string;
  if (request.headers.get('x-key-id')) {
    const ctx = readBuilderContext(request);
    if (ctx instanceof NextResponse) return ctx;
    builderId = ctx.builderId;
  } else {
    const ctx = readBuilderContextFromDashboard(request);
    if (ctx instanceof NextResponse) return ctx;
    if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
    const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
    if (gate) return gate;
    builderId = ctx.builderId;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(createSchema, body);
  if (!parsed.success) {
    return validationError(
      parsed.issues[0]?.message ?? 'Invalid cost-source payload',
      parsed.issues[0]?.path
        ?.map((p) => (typeof p.key === 'string' ? p.key : ''))
        .filter(Boolean)
        .join('.') || 'body',
    );
  }

  const input: CreateInput = parsed.output;
  const trackingStatus = (input.tracking_status ??
    CostSourceTrackingStatus.TRACKED) as TrackingStatus;
  const normalizedMatchers = normalizeMatchers(input.matchers, input.slug);
  const trackable = validateTrackable({
    source_type: input.source_type as CostSourceType,
    tracking_status: trackingStatus,
    metric: input.metric ?? null,
    unit: input.unit ?? null,
    matchers: normalizedMatchers,
    price_per_unit: input.price_per_unit ?? null,
    pricing_tiers: input.pricing_tiers ?? null,
  });
  if (!trackable.ok) return validationError(trackable.message, trackable.param);

  // ON CONFLICT DO NOTHING via onConflictDoNothing — idempotent for CLI reruns.
  const inserted = await withRLS(builderId, async (tx) => {
    const result = await tx
      .insert(costSources)
      .values({
        builder_id: builderId,
        source_type: input.source_type,
        display_name: input.display_name,
        slug: input.slug,
        metric: input.metric ?? null,
        unit: input.unit ?? null,
        price_per_unit: input.price_per_unit !== undefined ? String(input.price_per_unit) : null,
        pricing_tiers: input.pricing_tiers ?? null,
        tracking_status: trackingStatus,
        matchers: normalizedMatchers,
        default_metric_value: defaultMetricValueForCreate(input, trackingStatus),
        approved_at: trackingStatus === CostSourceTrackingStatus.TRACKED ? new Date() : null,
      })
      .onConflictDoNothing({ target: [costSources.builder_id, costSources.slug] })
      .returning();
    if (result.length === 1) return result[0]!;
    // Conflict path — fetch existing row.
    const [existing] = await tx
      .select()
      .from(costSources)
      .where(and(eq(costSources.builder_id, builderId), eq(costSources.slug, input.slug)))
      .limit(1);
    return existing!;
  });

  return NextResponse.json({ cost_source: rowToCostSource(inserted) }, { status: 201 });
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');
  // Track 2 PR 2.3: pricing edits are owner-only per O18 + §3 security
  // defaults. Members can read but not mutate cost-source rows.
  const gate = withRole([Role.OWNER], ctx.role as RoleType | null);
  if (gate) return gate;

  const { searchParams } = new URL(request.url);
  const slug = searchParams.get('slug');
  if (!slug) return validationError('slug query parameter required', 'slug');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(patchSchema, body);
  if (!parsed.success) {
    return validationError(parsed.issues[0]?.message ?? 'Invalid patch payload', 'body');
  }

  let updated: typeof costSources.$inferSelect | null;
  try {
    updated = await withRLS(ctx.builderId, async (tx) => {
      const patch = parsed.output;
      const [existing] = await tx
        .select()
        .from(costSources)
        .where(and(eq(costSources.builder_id, ctx.builderId), eq(costSources.slug, slug)))
        .limit(1);
      if (!existing) return null;

      const nextTrackingStatus = (patch.tracking_status ??
        existing.tracking_status) as TrackingStatus;
      const nextMatchers =
        patch.matchers !== undefined
          ? normalizeMatchers(patch.matchers, slug)
          : (existing.matchers ?? []);
      const nextPrice =
        patch.price_per_unit === undefined
          ? existing.price_per_unit === null
            ? null
            : Number(existing.price_per_unit)
          : patch.price_per_unit;
      const nextTiers =
        patch.pricing_tiers === undefined
          ? ((existing.pricing_tiers as PricingTier[] | null) ?? null)
          : patch.pricing_tiers;
      const trackable = validateTrackable({
        source_type: existing.source_type as CostSourceType,
        tracking_status: nextTrackingStatus,
        metric: patch.metric === undefined ? existing.metric : patch.metric,
        unit: patch.unit === undefined ? existing.unit : patch.unit,
        matchers: nextMatchers,
        price_per_unit: nextPrice,
        pricing_tiers: nextTiers,
      });
      if (!trackable.ok) {
        throw Object.assign(new Error(trackable.message), { param: trackable.param, status: 400 });
      }

      const setValues: Partial<typeof costSources.$inferInsert> = {};
      if (patch.display_name !== undefined) setValues.display_name = patch.display_name;
      if (patch.metric !== undefined) setValues.metric = patch.metric;
      if (patch.unit !== undefined) setValues.unit = patch.unit;
      if (patch.price_per_unit !== undefined) {
        setValues.price_per_unit =
          patch.price_per_unit === null ? null : String(patch.price_per_unit);
      }
      if (patch.pricing_tiers !== undefined) setValues.pricing_tiers = patch.pricing_tiers;
      if (patch.tracking_status !== undefined) {
        setValues.tracking_status = patch.tracking_status;
        if (patch.tracking_status === CostSourceTrackingStatus.TRACKED) {
          setValues.approved_at = new Date();
        }
      }
      if (patch.matchers !== undefined) setValues.matchers = nextMatchers;
      if (patch.default_metric_value !== undefined) {
        setValues.default_metric_value = patch.default_metric_value;
      }

      const result = await tx
        .update(costSources)
        .set(setValues)
        .where(and(eq(costSources.builder_id, ctx.builderId), eq(costSources.slug, slug)))
        .returning();
      return result[0] ?? null;
    });
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status?: unknown }).status === 400) {
      return validationError(err.message, String((err as { param?: unknown }).param ?? 'body'));
    }
    throw err;
  }

  if (!updated) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: 'cost source not found' } },
      { status: 404 },
    );
  }

  await withRLS(ctx.builderId, async (tx) => {
    await auditLog(tx, {
      builder_id: ctx.builderId,
      actor_type: 'user',
      actor_id: ctx.userId!,
      action: AuditAction.COST_SOURCE_UPDATE_PRICING,
      resource_type: 'cost_source',
      resource_id: updated.id,
      details: parsed.output as Record<string, unknown>,
    });
  });

  return NextResponse.json({ cost_source: rowToCostSource(updated) });
}
