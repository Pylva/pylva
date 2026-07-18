import {
  NUMERIC_38_18_PATTERN,
  NUMERIC_44_18_PATTERN,
  STORE_BLANK_STRING_PATTERN,
  STORE_LONE_SURROGATE_PATTERN,
  UINT32_MAX,
} from '@pylva/shared';
import type postgres from 'postgres';
import type { TransactionSql } from 'postgres';
import { pgJsonbParameterText } from './transaction.js';

export type AuthoritativePricingExecutor = TransactionSql;

export type AuthoritativePricingUsage =
  | {
      kind: 'llm';
      provider: string;
      model: string;
      estimated_input_tokens: number;
      max_output_tokens: number;
    }
  | {
      kind: 'tool';
      cost_source_slug: string;
      metric: string;
      maximum_value: string;
    };

export type AuthoritativeActualUsage =
  | {
      kind: 'llm';
      input_tokens: number;
      output_tokens: number;
    }
  | {
      kind: 'tool';
      value: string;
    };

export type AuthoritativePricingSnapshot = Record<string, postgres.JSONValue | undefined>;

export type AuthoritativePricingUnavailableCause =
  | 'invalid_input'
  | 'not_found'
  | 'ambiguous'
  | 'malformed'
  | 'out_of_range';

export interface AuthoritativePricingUnavailable {
  available: false;
  reason: 'pricing_unavailable';
  cause: AuthoritativePricingUnavailableCause;
}

export interface AuthoritativePricingResolved {
  available: true;
  requested_usd: string;
  pricing_snapshot: AuthoritativePricingSnapshot;
  pricing_snapshot_hash: string;
}

export type AuthoritativePricingResult =
  | AuthoritativePricingResolved
  | AuthoritativePricingUnavailable;

export interface AuthoritativeUsagePrice {
  available: true;
  cost_usd: string;
}

export type AuthoritativeUsagePriceResult =
  | AuthoritativeUsagePrice
  | AuthoritativePricingUnavailable;

export interface ResolveAuthoritativePricingInput {
  tx: AuthoritativePricingExecutor;
  builderId: string;
  usage: AuthoritativePricingUsage;
}

export interface PriceAuthoritativeUsageInput {
  tx: AuthoritativePricingExecutor;
  pricing_snapshot: AuthoritativePricingSnapshot;
  pricing_snapshot_hash: string;
  usage: AuthoritativeActualUsage;
  amount_kind: 'requested' | 'actual';
}

interface SnapshotResolutionRow {
  outcome: unknown;
  cause: unknown;
  pricing_snapshot: unknown;
  pricing_snapshot_hash: unknown;
}

interface CostResolutionRow {
  outcome: unknown;
  cause: unknown;
  cost_usd: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const COST_SOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const UNAVAILABLE_CAUSES = new Set<AuthoritativePricingUnavailableCause>([
  'invalid_input',
  'not_found',
  'ambiguous',
  'malformed',
  'out_of_range',
]);

function unavailable(cause: AuthoritativePricingUnavailableCause): AuthoritativePricingUnavailable {
  return { available: false, reason: 'pricing_unavailable', cause };
}

function isStoreSafeString(value: unknown, maxCodePoints: number): value is string {
  return (
    typeof value === 'string' &&
    [...value].length >= 1 &&
    [...value].length <= maxCodePoints &&
    !STORE_BLANK_STRING_PATTERN.test(value) &&
    !STORE_LONE_SURROGATE_PATTERN.test(value) &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function isUint32(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= UINT32_MAX
  );
}

function canonicalNumeric38(value: unknown): string | null {
  if (typeof value !== 'string' || !NUMERIC_38_18_PATTERN.test(value)) return null;
  if (!value.includes('.')) return value;
  return value.replace(/0+$/, '').replace(/\.$/, '');
}

function isSnapshot(value: unknown): value is AuthoritativePricingSnapshot {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unavailableCause(value: unknown): AuthoritativePricingUnavailableCause {
  if (
    typeof value === 'string' &&
    UNAVAILABLE_CAUSES.has(value as AuthoritativePricingUnavailableCause)
  ) {
    return value as AuthoritativePricingUnavailableCause;
  }
  throw new Error('Authoritative pricing query returned an invalid unavailable cause');
}

function parseSnapshotResolution(rows: readonly SnapshotResolutionRow[]):
  | {
      available: true;
      pricing_snapshot: AuthoritativePricingSnapshot;
      pricing_snapshot_hash: string;
    }
  | AuthoritativePricingUnavailable {
  if (rows.length !== 1) {
    throw new Error('Authoritative pricing query did not return exactly one row');
  }

  const row = rows[0];
  if (!row) throw new Error('Authoritative pricing query returned no row');
  if (row.outcome === 'unavailable') {
    if (row.pricing_snapshot !== null || row.pricing_snapshot_hash !== null) {
      throw new Error('Authoritative pricing query returned contradictory unavailable evidence');
    }
    return unavailable(unavailableCause(row.cause));
  }
  if (row.outcome !== 'available') {
    throw new Error('Authoritative pricing query returned an invalid outcome');
  }
  if (row.cause !== null) {
    throw new Error('Authoritative pricing query returned a cause for available pricing');
  }
  if (!isSnapshot(row.pricing_snapshot) || typeof row.pricing_snapshot_hash !== 'string') {
    throw new Error('Authoritative pricing query returned an invalid snapshot');
  }
  if (!SHA256_PATTERN.test(row.pricing_snapshot_hash)) {
    throw new Error('Authoritative pricing query returned an invalid snapshot hash');
  }
  return {
    available: true,
    pricing_snapshot: row.pricing_snapshot,
    pricing_snapshot_hash: row.pricing_snapshot_hash,
  };
}

function parseCostResolution(
  rows: readonly CostResolutionRow[],
  amountKind: 'requested' | 'actual',
): AuthoritativeUsagePriceResult {
  if (rows.length !== 1) {
    throw new Error('Authoritative cost query did not return exactly one row');
  }
  const row = rows[0];
  if (!row) throw new Error('Authoritative cost query returned no row');
  if (row.outcome === 'unavailable') {
    if (row.cost_usd !== null) {
      throw new Error('Authoritative cost query returned contradictory unavailable evidence');
    }
    return unavailable(unavailableCause(row.cause));
  }
  const amountPattern = amountKind === 'requested' ? NUMERIC_38_18_PATTERN : NUMERIC_44_18_PATTERN;
  if (
    row.outcome !== 'available' ||
    row.cause !== null ||
    typeof row.cost_usd !== 'string' ||
    !amountPattern.test(row.cost_usd) ||
    (row.cost_usd.includes('.') && row.cost_usd.endsWith('0'))
  ) {
    throw new Error('Authoritative cost query returned an invalid result');
  }
  return { available: true, cost_usd: row.cost_usd };
}

async function resolveLlmSnapshot(
  tx: AuthoritativePricingExecutor,
  builderId: string,
  provider: string,
  model: string,
): Promise<ReturnType<typeof parseSnapshotResolution>> {
  const rows = await tx<SnapshotResolutionRow[]>`
    WITH server_clock AS MATERIALIZED (
      SELECT statement_timestamp() AS now
    ),
    custom_active AS MATERIALIZED (
      SELECT
        cp.id::text AS pricing_id,
        cp.source::text AS source_detail,
        cp.effective_from,
        cp.effective_to,
        COALESCE(cp.input_per_1m_usd, cp.price_per_unit_usd * 1000000::numeric) AS input_rate,
        COALESCE(cp.output_per_1m_usd, cp.price_per_unit_usd * 1000000::numeric) AS output_rate,
        (
          cp.metric IS NULL
          AND cp.provider IS NOT NULL
          AND cp.model IS NOT NULL
          AND cp.price_per_unit_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND cp.price_per_unit_usd >= 0
          AND (
            cp.input_per_1m_usd IS NULL
            OR (
              cp.input_per_1m_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
              AND cp.input_per_1m_usd >= 0
            )
          )
          AND (
            cp.output_per_1m_usd IS NULL
            OR (
              cp.output_per_1m_usd::text NOT IN ('NaN', 'Infinity', '-Infinity')
              AND cp.output_per_1m_usd >= 0
            )
          )
          AND public.pylva_budget_timestamp_is_wire_safe(cp.effective_from)
          AND (
            cp.effective_to IS NULL
            OR public.pylva_budget_timestamp_is_wire_safe(cp.effective_to)
          )
        ) AS is_valid
      FROM custom_pricing AS cp
      CROSS JOIN server_clock AS clock
      WHERE cp.builder_id = ${builderId}::uuid
        AND cp.provider = ${provider}
        AND cp.model = ${model}
        AND cp.effective_from <= clock.now
        AND (cp.effective_to IS NULL OR cp.effective_to > clock.now)
    ),
    global_active AS MATERIALIZED (
      SELECT
        lp.id::text AS pricing_id,
        lp.source::text AS source_detail,
        lp.effective_from,
        lp.effective_to,
        lp.input_per_1m AS input_rate,
        lp.output_per_1m AS output_rate,
        (
          lp.input_per_1m::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND lp.output_per_1m::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND lp.input_per_1m >= 0
          AND lp.output_per_1m >= 0
          AND public.pylva_budget_timestamp_is_wire_safe(lp.effective_from)
          AND (
            lp.effective_to IS NULL
            OR public.pylva_budget_timestamp_is_wire_safe(lp.effective_to)
          )
        ) AS is_valid
      FROM llm_pricing AS lp
      CROSS JOIN server_clock AS clock
      WHERE lp.provider = ${provider}
        AND lp.model = ${model}
        AND lp.effective_from <= clock.now
        AND (lp.effective_to IS NULL OR lp.effective_to > clock.now)
    ),
    counts AS (
      SELECT
        (SELECT count(*) FROM custom_active) AS custom_count,
        (SELECT count(*) FROM global_active) AS global_count
    ),
    decision AS (
      SELECT
        CASE
          WHEN custom_count > 1 THEN 'unavailable'
          WHEN custom_count = 1 AND NOT (SELECT is_valid FROM custom_active) THEN 'unavailable'
          WHEN custom_count = 1 THEN 'available'
          WHEN global_count > 1 THEN 'unavailable'
          WHEN global_count = 1 AND NOT (SELECT is_valid FROM global_active) THEN 'unavailable'
          WHEN global_count = 1 THEN 'available'
          ELSE 'unavailable'
        END AS outcome,
        CASE
          WHEN custom_count > 1 THEN 'ambiguous'
          WHEN custom_count = 1 AND NOT (SELECT is_valid FROM custom_active) THEN 'malformed'
          WHEN custom_count = 1 THEN NULL
          WHEN global_count > 1 THEN 'ambiguous'
          WHEN global_count = 1 AND NOT (SELECT is_valid FROM global_active) THEN 'malformed'
          WHEN global_count = 1 THEN NULL
          ELSE 'not_found'
        END AS cause,
        custom_count,
        global_count
      FROM counts
    ),
    chosen AS (
      SELECT
        'custom_pricing'::text AS source,
        pricing_id,
        source_detail,
        effective_from,
        effective_to,
        input_rate,
        output_rate
      FROM custom_active
      CROSS JOIN decision
      WHERE decision.custom_count = 1 AND decision.outcome = 'available'

      UNION ALL

      SELECT
        'llm_pricing'::text AS source,
        pricing_id,
        source_detail,
        effective_from,
        effective_to,
        input_rate,
        output_rate
      FROM global_active
      CROSS JOIN decision
      WHERE decision.custom_count = 0
        AND decision.global_count = 1
        AND decision.outcome = 'available'
    ),
    snapshot AS (
      SELECT jsonb_build_object(
        'schema_version', '1.0',
        'kind', 'llm',
        'source', source,
        'pricing_id', pricing_id,
        'source_detail', source_detail,
        'provider', ${provider}::text,
        'model', ${model}::text,
        'pricing_model', 'per_million_tokens',
        'input_per_million_usd', public.pylva_budget_decimal_text(input_rate),
        'output_per_million_usd', public.pylva_budget_decimal_text(output_rate),
        'effective_from', public.pylva_budget_timestamp_text(effective_from),
        'effective_to', CASE
          WHEN effective_to IS NULL THEN NULL
          ELSE public.pylva_budget_timestamp_text(effective_to)
        END
      ) AS value
      FROM chosen
    )
    SELECT
      decision.outcome,
      decision.cause,
      snapshot.value AS pricing_snapshot,
      CASE
        WHEN snapshot.value IS NULL THEN NULL
        ELSE public.pylva_budget_jsonb_sha256(snapshot.value)
      END AS pricing_snapshot_hash
    FROM decision
    LEFT JOIN snapshot ON TRUE
  `;

  return parseSnapshotResolution(rows);
}

async function resolveToolSnapshot(
  tx: AuthoritativePricingExecutor,
  builderId: string,
  slug: string,
  metric: string,
): Promise<ReturnType<typeof parseSnapshotResolution>> {
  const rows = await tx<SnapshotResolutionRow[]>`
    WITH server_clock AS MATERIALIZED (
      SELECT statement_timestamp() AS now
    ),
    candidates AS MATERIALIZED (
      SELECT cs.*
      FROM cost_sources AS cs
      WHERE cs.builder_id = ${builderId}::uuid
        AND cs.slug = ${slug}
    ),
    candidate_count AS (
      SELECT count(*) AS value FROM candidates
    ),
    selected AS (
      SELECT
        candidates.*,
        (
          source_type = 'non_llm_manual'
          AND metric IS NOT DISTINCT FROM ${metric}::text
          AND tracking_status = 'tracked'
          AND approved_at IS NOT NULL
          AND approved_at <= server_clock.now
          AND public.pylva_budget_timestamp_is_wire_safe(approved_at)
        ) AS is_eligible,
        (price_per_unit IS NOT NULL AND pricing_tiers IS NULL) AS is_flat,
        (
          price_per_unit IS NULL
          AND CASE
            WHEN jsonb_typeof(pricing_tiers) = 'array'
              THEN jsonb_array_length(pricing_tiers) > 0
            ELSE false
          END
        ) AS is_volume,
        (
          price_per_unit IS NOT NULL
          AND price_per_unit::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND price_per_unit >= 0
          AND price_per_unit <= 999999.999999::numeric
          AND trunc(price_per_unit, 6) = price_per_unit
        ) AS flat_rate_valid
      FROM candidates
      CROSS JOIN server_clock
      WHERE (SELECT value FROM candidate_count) = 1
    ),
    raw_tiers AS MATERIALIZED (
      SELECT tier.value, tier.ordinality
      FROM selected
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(selected.pricing_tiers) = 'array' THEN selected.pricing_tiers
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS tier(value, ordinality)
    ),
    tier_shapes AS (
      SELECT
        value,
        ordinality,
        COALESCE((
          jsonb_typeof(value) = 'object'
          AND (value - ARRAY['from', 'to', 'price']::text[]) = '{}'::jsonb
          AND jsonb_typeof(value->'from') = 'number'
          AND (
            jsonb_typeof(value->'to') = 'number'
            OR value->'to' = 'null'::jsonb
          )
          AND jsonb_typeof(value->'price') = 'number'
        ), false) AS shape_valid
      FROM raw_tiers
    ),
    tier_values AS MATERIALIZED (
      SELECT
        ordinality,
        shape_valid,
        CASE WHEN shape_valid THEN (value->>'from')::numeric END AS from_value,
        CASE
          WHEN shape_valid AND value->'to' <> 'null'::jsonb THEN (value->>'to')::numeric
        END AS to_value,
        CASE WHEN shape_valid THEN (value->>'price')::numeric END AS price_value,
        CASE WHEN shape_valid THEN value->'to' = 'null'::jsonb ELSE false END AS open_ended
      FROM tier_shapes
    ),
    tier_windows AS (
      SELECT
        tier_values.*,
        count(*) OVER () AS tier_count,
        lag(to_value) OVER (ORDER BY ordinality) AS previous_to
      FROM tier_values
    ),
    tier_summary AS (
      SELECT
        count(*) AS tier_count,
        COALESCE(bool_and(
          shape_valid
          AND from_value::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND from_value >= 0
          AND from_value <= 99999999999999999999.999999999999999999::numeric
          AND trunc(from_value, 18) = from_value
          AND price_value::text NOT IN ('NaN', 'Infinity', '-Infinity')
          AND price_value >= 0
          AND price_value <= 999999.999999::numeric
          AND trunc(price_value, 6) = price_value
          AND CASE
            WHEN ordinality = 1 THEN from_value = 0
            ELSE previous_to IS NOT NULL AND from_value = previous_to
          END
          AND CASE
            WHEN open_ended THEN ordinality = tier_count
            ELSE
              to_value IS NOT NULL
              AND to_value::text NOT IN ('NaN', 'Infinity', '-Infinity')
              AND to_value > from_value
              AND to_value <= 99999999999999999999.999999999999999999::numeric
              AND trunc(to_value, 18) = to_value
          END
        ), false) AS is_valid,
        jsonb_agg(
          jsonb_build_object(
            'from', public.pylva_budget_decimal_text(from_value),
            'to', CASE
              WHEN open_ended THEN NULL
              ELSE public.pylva_budget_decimal_text(to_value)
            END,
            'price_per_unit_usd', public.pylva_budget_decimal_text(price_value)
          )
          ORDER BY ordinality
        ) AS canonical_tiers
      FROM tier_windows
    ),
    decision AS (
      SELECT
        CASE
          WHEN candidate_count.value = 0 THEN 'unavailable'
          WHEN candidate_count.value > 1 THEN 'unavailable'
          WHEN NOT selected.is_eligible THEN 'unavailable'
          WHEN selected.is_flat AND selected.flat_rate_valid THEN 'available'
          WHEN selected.is_volume AND tier_summary.is_valid THEN 'available'
          ELSE 'unavailable'
        END AS outcome,
        CASE
          WHEN candidate_count.value = 0 THEN 'not_found'
          WHEN candidate_count.value > 1 THEN 'ambiguous'
          WHEN NOT selected.is_eligible THEN 'not_found'
          WHEN selected.is_flat AND selected.flat_rate_valid THEN NULL
          WHEN selected.is_volume AND tier_summary.is_valid THEN NULL
          ELSE 'malformed'
        END AS cause
      FROM candidate_count
      LEFT JOIN selected ON TRUE
      LEFT JOIN tier_summary ON TRUE
    ),
    snapshot AS (
      SELECT
        CASE
          WHEN selected.is_flat THEN jsonb_build_object(
            'schema_version', '1.0',
            'kind', 'tool',
            'source', 'cost_sources',
            'pricing_id', selected.id::text,
            'source_type', selected.source_type,
            'tracking_status', selected.tracking_status,
            'source_status', selected.status,
            'cost_source_slug', selected.slug,
            'metric', selected.metric,
            'unit', selected.unit,
            'approved_at', public.pylva_budget_timestamp_text(selected.approved_at),
            'pricing_model', 'flat',
            'unit_cost_usd', public.pylva_budget_decimal_text(selected.price_per_unit)
          )
          ELSE jsonb_build_object(
            'schema_version', '1.0',
            'kind', 'tool',
            'source', 'cost_sources',
            'pricing_id', selected.id::text,
            'source_type', selected.source_type,
            'tracking_status', selected.tracking_status,
            'source_status', selected.status,
            'cost_source_slug', selected.slug,
            'metric', selected.metric,
            'unit', selected.unit,
            'approved_at', public.pylva_budget_timestamp_text(selected.approved_at),
            'pricing_model', 'volume',
            'tiers', tier_summary.canonical_tiers
          )
        END AS value
      FROM selected
      CROSS JOIN decision
      LEFT JOIN tier_summary ON TRUE
      WHERE decision.outcome = 'available'
    )
    SELECT
      decision.outcome,
      decision.cause,
      snapshot.value AS pricing_snapshot,
      CASE
        WHEN snapshot.value IS NULL THEN NULL
        ELSE public.pylva_budget_jsonb_sha256(snapshot.value)
      END AS pricing_snapshot_hash
    FROM decision
    LEFT JOIN snapshot ON TRUE
  `;

  return parseSnapshotResolution(rows);
}

async function priceLlmUsage(
  tx: AuthoritativePricingExecutor,
  snapshot: AuthoritativePricingSnapshot,
  snapshotHash: string,
  inputTokens: number,
  outputTokens: number,
  amountKind: 'requested' | 'actual',
): Promise<AuthoritativeUsagePriceResult> {
  const rows = await tx<CostResolutionRow[]>`
    WITH supplied AS MATERIALIZED (
      SELECT
        ${pgJsonbParameterText(snapshot as postgres.JSONValue)}::text::jsonb AS snapshot,
        ${snapshotHash}::text AS snapshot_hash,
        ${inputTokens}::numeric AS input_tokens,
        ${outputTokens}::numeric AS output_tokens,
        ${amountKind}::text AS amount_kind
    ),
    shape AS (
      SELECT
        supplied.*,
        (
          jsonb_typeof(snapshot) = 'object'
          AND (snapshot - ARRAY[
            'schema_version', 'kind', 'source', 'pricing_id', 'source_detail',
            'provider', 'model', 'pricing_model', 'input_per_million_usd',
            'output_per_million_usd', 'effective_from', 'effective_to'
          ]::text[]) = '{}'::jsonb
          AND snapshot->>'schema_version' = '1.0'
          AND snapshot->>'kind' = 'llm'
          AND snapshot->>'source' IN ('custom_pricing', 'llm_pricing')
          AND jsonb_typeof(snapshot->'pricing_id') = 'string'
          AND jsonb_typeof(snapshot->'source_detail') = 'string'
          AND jsonb_typeof(snapshot->'provider') = 'string'
          AND jsonb_typeof(snapshot->'model') = 'string'
          AND snapshot->>'pricing_model' = 'per_million_tokens'
          AND jsonb_typeof(snapshot->'input_per_million_usd') = 'string'
          AND jsonb_typeof(snapshot->'output_per_million_usd') = 'string'
          AND jsonb_typeof(snapshot->'effective_from') = 'string'
          AND (
            jsonb_typeof(snapshot->'effective_to') = 'string'
            OR snapshot->'effective_to' = 'null'::jsonb
          )
          AND snapshot_hash ~ '^[0-9a-f]{64}$'
          AND snapshot_hash = public.pylva_budget_jsonb_sha256(snapshot)
          AND (snapshot->>'input_per_million_usd') ~ '^(?:0|[1-9][0-9]{0,13})(?:[.][0-9]{1,10})?$'
          AND (snapshot->>'output_per_million_usd') ~ '^(?:0|[1-9][0-9]{0,13})(?:[.][0-9]{1,10})?$'
          AND CASE snapshot->>'source'
            WHEN 'custom_pricing' THEN
              (snapshot->>'pricing_id') ~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
              AND snapshot->>'source_detail' IN ('builder_manual', 'litellm_sync', 'admin_override')
            WHEN 'llm_pricing' THEN
              (snapshot->>'pricing_id') ~ '^[1-9][0-9]*$'
              AND snapshot->>'source_detail' IN ('auto', 'admin')
            ELSE false
          END
        ) AS shape_valid
      FROM supplied
    ),
    parsed AS (
      SELECT
        shape.*,
        CASE
          WHEN shape_valid THEN (snapshot->>'input_per_million_usd')::numeric
        END AS input_rate,
        CASE
          WHEN shape_valid THEN (snapshot->>'output_per_million_usd')::numeric
        END AS output_rate
      FROM shape
    ),
    calculated AS (
      SELECT
        parsed.*,
        COALESCE((
          shape_valid
          AND public.pylva_budget_decimal_text(input_rate)
            = snapshot->>'input_per_million_usd'
          AND public.pylva_budget_decimal_text(output_rate)
            = snapshot->>'output_per_million_usd'
        ), false) AS formula_valid,
        CASE
          WHEN shape_valid THEN
            ceil(
              (input_tokens * input_rate + output_tokens * output_rate)
                * 1000000000000::numeric
            ) * 0.000000000000000001::numeric
        END AS ceiled_cost
      FROM parsed
    ),
    decision AS (
      SELECT
        CASE
          WHEN formula_valid IS NOT TRUE THEN 'unavailable'
          WHEN ceiled_cost::text IN ('NaN', 'Infinity', '-Infinity') OR ceiled_cost < 0
            THEN 'unavailable'
          WHEN amount_kind = 'requested'
            AND ceiled_cost > 99999999999999999999.999999999999999999::numeric
            THEN 'unavailable'
          WHEN amount_kind = 'actual'
            AND ceiled_cost > 99999999999999999999999999.999999999999999999::numeric
            THEN 'unavailable'
          ELSE 'available'
        END AS outcome,
        CASE
          WHEN formula_valid IS NOT TRUE THEN 'malformed'
          WHEN ceiled_cost::text IN ('NaN', 'Infinity', '-Infinity') OR ceiled_cost < 0
            THEN 'malformed'
          WHEN amount_kind = 'requested'
            AND ceiled_cost > 99999999999999999999.999999999999999999::numeric
            THEN 'out_of_range'
          WHEN amount_kind = 'actual'
            AND ceiled_cost > 99999999999999999999999999.999999999999999999::numeric
            THEN 'out_of_range'
          ELSE NULL
        END AS cause,
        ceiled_cost
      FROM calculated
    )
    SELECT
      outcome,
      cause,
      CASE
        WHEN outcome = 'available' THEN public.pylva_budget_decimal_text(ceiled_cost)
        ELSE NULL
      END AS cost_usd
    FROM decision
  `;

  return parseCostResolution(rows, amountKind);
}

async function priceToolUsage(
  tx: AuthoritativePricingExecutor,
  snapshot: AuthoritativePricingSnapshot,
  snapshotHash: string,
  quantity: string,
  amountKind: 'requested' | 'actual',
): Promise<AuthoritativeUsagePriceResult> {
  const rows = await tx<CostResolutionRow[]>`
    WITH supplied AS MATERIALIZED (
      SELECT
        ${pgJsonbParameterText(snapshot as postgres.JSONValue)}::text::jsonb AS snapshot,
        ${snapshotHash}::text AS snapshot_hash,
        ${quantity}::numeric AS quantity,
        ${amountKind}::text AS amount_kind
    ),
    common_shape AS (
      SELECT
        supplied.*,
        (
          jsonb_typeof(snapshot) = 'object'
          AND snapshot->>'schema_version' = '1.0'
          AND snapshot->>'kind' = 'tool'
          AND snapshot->>'source' = 'cost_sources'
          AND jsonb_typeof(snapshot->'pricing_id') = 'string'
          AND (snapshot->>'pricing_id') ~* '^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
          AND snapshot->>'source_type' = 'non_llm_manual'
          AND snapshot->>'tracking_status' = 'tracked'
          AND snapshot->>'source_status' IN ('healthy', 'warning', 'broken')
          AND jsonb_typeof(snapshot->'cost_source_slug') = 'string'
          AND (snapshot->>'cost_source_slug') ~ '^[a-z0-9][a-z0-9-]{0,99}$'
          AND jsonb_typeof(snapshot->'metric') = 'string'
          AND jsonb_typeof(snapshot->'approved_at') = 'string'
          AND (
            jsonb_typeof(snapshot->'unit') = 'string'
            OR snapshot->'unit' = 'null'::jsonb
          )
          AND snapshot_hash ~ '^[0-9a-f]{64}$'
          AND snapshot_hash = public.pylva_budget_jsonb_sha256(snapshot)
        ) AS common_valid
      FROM supplied
    ),
    model_shape AS (
      SELECT
        common_shape.*,
        CASE snapshot->>'pricing_model'
          WHEN 'flat' THEN
            (snapshot - ARRAY[
              'schema_version', 'kind', 'source', 'pricing_id', 'source_type',
              'tracking_status', 'source_status', 'cost_source_slug', 'metric',
              'unit', 'approved_at', 'pricing_model', 'unit_cost_usd'
            ]::text[]) = '{}'::jsonb
            AND jsonb_typeof(snapshot->'unit_cost_usd') = 'string'
            AND (snapshot->>'unit_cost_usd') ~ '^(?:0|[1-9][0-9]{0,5})(?:[.][0-9]{1,6})?$'
          WHEN 'volume' THEN
            (snapshot - ARRAY[
              'schema_version', 'kind', 'source', 'pricing_id', 'source_type',
              'tracking_status', 'source_status', 'cost_source_slug', 'metric',
              'unit', 'approved_at', 'pricing_model', 'tiers'
            ]::text[]) = '{}'::jsonb
            AND CASE
              WHEN jsonb_typeof(snapshot->'tiers') = 'array'
                THEN jsonb_array_length(snapshot->'tiers') > 0
              ELSE false
            END
          ELSE false
        END AS model_valid
      FROM common_shape
    ),
    raw_tiers AS MATERIALIZED (
      SELECT tier.value, tier.ordinality
      FROM model_shape
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE
          WHEN jsonb_typeof(snapshot->'tiers') = 'array' THEN snapshot->'tiers'
          ELSE '[]'::jsonb
        END
      ) WITH ORDINALITY AS tier(value, ordinality)
    ),
    tier_shapes AS (
      SELECT
        value,
        ordinality,
        COALESCE((
          jsonb_typeof(value) = 'object'
          AND (value - ARRAY['from', 'to', 'price_per_unit_usd']::text[]) = '{}'::jsonb
          AND jsonb_typeof(value->'from') = 'string'
          AND (
            jsonb_typeof(value->'to') = 'string'
            OR value->'to' = 'null'::jsonb
          )
          AND jsonb_typeof(value->'price_per_unit_usd') = 'string'
          AND (value->>'from') ~ '^(?:0|[1-9][0-9]{0,19})(?:[.][0-9]{1,18})?$'
          AND (
            value->'to' = 'null'::jsonb
            OR (value->>'to') ~ '^(?:0|[1-9][0-9]{0,19})(?:[.][0-9]{1,18})?$'
          )
          AND (value->>'price_per_unit_usd') ~ '^(?:0|[1-9][0-9]{0,5})(?:[.][0-9]{1,6})?$'
        ), false) AS shape_valid
      FROM raw_tiers
    ),
    tier_values AS MATERIALIZED (
      SELECT
        ordinality,
        shape_valid,
        value->>'from' AS from_text,
        value->>'to' AS to_text,
        value->>'price_per_unit_usd' AS price_text,
        CASE WHEN shape_valid THEN (value->>'from')::numeric END AS from_value,
        CASE
          WHEN shape_valid AND value->'to' <> 'null'::jsonb THEN (value->>'to')::numeric
        END AS to_value,
        CASE WHEN shape_valid THEN (value->>'price_per_unit_usd')::numeric END AS price_value,
        CASE WHEN shape_valid THEN value->'to' = 'null'::jsonb ELSE false END AS open_ended
      FROM tier_shapes
    ),
    tier_windows AS (
      SELECT
        tier_values.*,
        count(*) OVER () AS tier_count,
        lag(to_value) OVER (ORDER BY ordinality) AS previous_to
      FROM tier_values
    ),
    tier_summary AS (
      SELECT
        count(*) AS tier_count,
        COALESCE(bool_and(
          shape_valid
          AND public.pylva_budget_decimal_text(from_value) = from_text
          AND public.pylva_budget_decimal_text(price_value) = price_text
          AND CASE
            WHEN ordinality = 1 THEN from_value = 0
            ELSE previous_to IS NOT NULL AND from_value = previous_to
          END
          AND CASE
            WHEN open_ended THEN ordinality = tier_count
            ELSE
              to_value IS NOT NULL
              AND public.pylva_budget_decimal_text(to_value) = to_text
              AND to_value > from_value
          END
        ), false) AS tiers_valid,
        bool_or(open_ended AND ordinality = tier_count) AS final_open,
        max(to_value) FILTER (WHERE ordinality = tier_count) AS final_to,
        sum(
          greatest(
            least(model_shape.quantity, COALESCE(to_value, model_shape.quantity)) - from_value,
            0::numeric
          ) * price_value
        ) AS tier_total
      FROM model_shape
      LEFT JOIN tier_windows ON TRUE
      GROUP BY model_shape.quantity
    ),
    exact_cost AS (
      SELECT
        model_shape.*,
        tier_summary.tiers_valid,
        tier_summary.final_open,
        tier_summary.final_to,
        CASE snapshot->>'pricing_model'
          WHEN 'flat' THEN
            CASE
              WHEN common_valid AND model_valid THEN
                public.pylva_budget_decimal_text((snapshot->>'unit_cost_usd')::numeric)
                  = snapshot->>'unit_cost_usd'
              ELSE false
            END
          WHEN 'volume' THEN
            common_valid AND model_valid AND tier_summary.tiers_valid
          ELSE false
        END AS formula_valid,
        CASE snapshot->>'pricing_model'
          WHEN 'flat' THEN
            CASE
              WHEN common_valid AND model_valid THEN
                quantity * (snapshot->>'unit_cost_usd')::numeric
            END
          WHEN 'volume' THEN
            CASE
              WHEN common_valid AND model_valid AND tier_summary.tiers_valid THEN
                tier_summary.tier_total
            END
          ELSE NULL
        END AS total
      FROM model_shape
      LEFT JOIN tier_summary ON TRUE
    ),
    ceiled AS (
      SELECT
        exact_cost.*,
        CASE
          WHEN total IS NOT NULL THEN
            ceil(total * 1000000000000000000::numeric)
              * 0.000000000000000001::numeric
        END AS ceiled_cost
      FROM exact_cost
    ),
    decision AS (
      SELECT
        CASE
          WHEN common_valid IS NOT TRUE
            OR model_valid IS NOT TRUE
            OR formula_valid IS NOT TRUE
            THEN 'unavailable'
          WHEN snapshot->>'pricing_model' = 'volume'
            AND NOT COALESCE(final_open, false)
            AND quantity > final_to
            THEN 'unavailable'
          WHEN ceiled_cost::text IN ('NaN', 'Infinity', '-Infinity') OR ceiled_cost < 0
            THEN 'unavailable'
          WHEN amount_kind = 'requested'
            AND ceiled_cost > 99999999999999999999.999999999999999999::numeric
            THEN 'unavailable'
          WHEN amount_kind = 'actual'
            AND ceiled_cost > 99999999999999999999999999.999999999999999999::numeric
            THEN 'unavailable'
          ELSE 'available'
        END AS outcome,
        CASE
          WHEN common_valid IS NOT TRUE
            OR model_valid IS NOT TRUE
            OR formula_valid IS NOT TRUE
            THEN 'malformed'
          WHEN snapshot->>'pricing_model' = 'volume'
            AND NOT COALESCE(final_open, false)
            AND quantity > final_to
            THEN 'not_found'
          WHEN ceiled_cost::text IN ('NaN', 'Infinity', '-Infinity') OR ceiled_cost < 0
            THEN 'malformed'
          WHEN amount_kind = 'requested'
            AND ceiled_cost > 99999999999999999999.999999999999999999::numeric
            THEN 'out_of_range'
          WHEN amount_kind = 'actual'
            AND ceiled_cost > 99999999999999999999999999.999999999999999999::numeric
            THEN 'out_of_range'
          ELSE NULL
        END AS cause,
        ceiled_cost
      FROM ceiled
    )
    SELECT
      outcome,
      cause,
      CASE
        WHEN outcome = 'available' THEN public.pylva_budget_decimal_text(ceiled_cost)
        ELSE NULL
      END AS cost_usd
    FROM decision
  `;

  return parseCostResolution(rows, amountKind);
}

export async function priceAuthoritativeUsage(
  input: PriceAuthoritativeUsageInput,
): Promise<AuthoritativeUsagePriceResult> {
  if (!SHA256_PATTERN.test(input.pricing_snapshot_hash)) return unavailable('invalid_input');
  if (!isSnapshot(input.pricing_snapshot)) return unavailable('invalid_input');
  if (input.amount_kind !== 'requested' && input.amount_kind !== 'actual') {
    return unavailable('invalid_input');
  }

  if (input.usage.kind === 'llm') {
    if (!isUint32(input.usage.input_tokens) || !isUint32(input.usage.output_tokens)) {
      return unavailable('invalid_input');
    }
    if (input.pricing_snapshot['kind'] !== 'llm') return unavailable('malformed');
    return priceLlmUsage(
      input.tx,
      input.pricing_snapshot,
      input.pricing_snapshot_hash,
      input.usage.input_tokens,
      input.usage.output_tokens,
      input.amount_kind,
    );
  }

  if (input.usage.kind === 'tool') {
    const quantity = canonicalNumeric38(input.usage.value);
    if (quantity === null) return unavailable('invalid_input');
    if (input.pricing_snapshot['kind'] !== 'tool') return unavailable('malformed');
    return priceToolUsage(
      input.tx,
      input.pricing_snapshot,
      input.pricing_snapshot_hash,
      quantity,
      input.amount_kind,
    );
  }

  return unavailable('invalid_input');
}

export async function resolveAuthoritativePricing(
  input: ResolveAuthoritativePricingInput,
): Promise<AuthoritativePricingResult> {
  if (!UUID_PATTERN.test(input.builderId)) return unavailable('invalid_input');

  let resolved:
    | {
        available: true;
        pricing_snapshot: AuthoritativePricingSnapshot;
        pricing_snapshot_hash: string;
      }
    | AuthoritativePricingUnavailable;
  let pricedUsage: AuthoritativeActualUsage;

  if (input.usage.kind === 'llm') {
    if (
      !isStoreSafeString(input.usage.provider, 255) ||
      !isStoreSafeString(input.usage.model, 255) ||
      !isUint32(input.usage.estimated_input_tokens) ||
      !isUint32(input.usage.max_output_tokens)
    ) {
      return unavailable('invalid_input');
    }
    resolved = await resolveLlmSnapshot(
      input.tx,
      input.builderId,
      input.usage.provider,
      input.usage.model,
    );
    pricedUsage = {
      kind: 'llm',
      input_tokens: input.usage.estimated_input_tokens,
      output_tokens: input.usage.max_output_tokens,
    };
  } else if (input.usage.kind === 'tool') {
    const maximumValue = canonicalNumeric38(input.usage.maximum_value);
    if (
      !COST_SOURCE_SLUG_PATTERN.test(input.usage.cost_source_slug) ||
      !isStoreSafeString(input.usage.metric, 100) ||
      maximumValue === null
    ) {
      return unavailable('invalid_input');
    }
    resolved = await resolveToolSnapshot(
      input.tx,
      input.builderId,
      input.usage.cost_source_slug,
      input.usage.metric,
    );
    pricedUsage = { kind: 'tool', value: maximumValue };
  } else {
    return unavailable('invalid_input');
  }

  if (!resolved.available) return resolved;

  const priced = await priceAuthoritativeUsage({
    tx: input.tx,
    pricing_snapshot: resolved.pricing_snapshot,
    pricing_snapshot_hash: resolved.pricing_snapshot_hash,
    usage: pricedUsage,
    amount_kind: 'requested',
  });
  if (!priced.available) return priced;

  return {
    available: true,
    requested_usd: priced.cost_usd,
    pricing_snapshot: resolved.pricing_snapshot,
    pricing_snapshot_hash: resolved.pricing_snapshot_hash,
  };
}
