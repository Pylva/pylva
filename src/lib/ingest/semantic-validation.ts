// Post-schema semantic validation (spec §4.10). Runs AFTER Valibot has accepted
// the wire shape. Violations produce { ok: false, error } which the ingest
// route aggregates into IngestResponse.errors[].

import { EventStatus, InstrumentationTier, type TelemetryEvent } from '@pylva/shared';
import {
  isStorableCostUsd,
  MAX_STORABLE_COST_USD,
  UINT32_MAX,
} from '../clickhouse/decimal-limits.js';

export type SemanticResult = { ok: true } | { ok: false; error: string };

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const METRIC_VALUE_MAX = 1_000_000_000;

// customer_id cannot contain ':' (reserved for the composite-key prefix we
// prepend at insert time) or whitespace.
const FORBIDDEN_CUSTOMER_ID_CHARS = /[:\s]/;

function fitsUInt32(value: number): boolean {
  return Number.isFinite(value) && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX;
}

export function validateSemantic(event: TelemetryEvent, now = new Date()): SemanticResult {
  const ts = new Date(event.timestamp);
  if (Number.isNaN(ts.getTime())) {
    return { ok: false, error: 'invalid timestamp' };
  }
  if (ts.getTime() > now.getTime() + FIFTEEN_MIN_MS) {
    return { ok: false, error: 'timestamp exceeds NOW() + 15 minutes' };
  }

  if (FORBIDDEN_CUSTOMER_ID_CHARS.test(event.customer_id)) {
    return {
      ok: false,
      error: 'customer_id contains forbidden character (colon or whitespace)',
    };
  }

  // abort_savings_usd is SDK-provided and written verbatim to the
  // cost_events.abort_savings Decimal(10,6) column. The wire schema only
  // enforces >= 0, so a value above the storable maximum would overflow on
  // INSERT and fail the entire ClickHouse batch (poison-pill → 500 → every
  // event in the batch lost). Reject the single offending event instead.
  if (!isStorableCostUsd(event.abort_savings_usd)) {
    return {
      ok: false,
      error: `abort_savings_usd ${event.abort_savings_usd} must be between 0 and the storable maximum of ${MAX_STORABLE_COST_USD}`,
    };
  }

  if (!fitsUInt32(event.tokens_in) || !fitsUInt32(event.tokens_out)) {
    return {
      ok: false,
      error: `tokens_in/tokens_out must fit UInt32 (0-${UINT32_MAX})`,
    };
  }

  const isAbortedStatus = event.status === EventStatus.ABORTED;
  if (isAbortedStatus !== event.stream_aborted) {
    return {
      ok: false,
      error: "status must equal 'aborted' if and only if stream_aborted is true",
    };
  }

  if (event.instrumentation_tier === InstrumentationTier.SDK_WRAPPER) {
    if (event.model == null) {
      return { ok: false, error: 'sdk_wrapper tier requires non-null model' };
    }
    if (event.provider == null) {
      return {
        ok: false,
        error: 'sdk_wrapper tier requires non-null provider',
      };
    }
    if (event.metric != null || event.metric_value != null) {
      return {
        ok: false,
        error: 'sdk_wrapper tier forbids metric / metric_value',
      };
    }
    return { ok: true };
  }

  if (event.instrumentation_tier === InstrumentationTier.REPORTED) {
    if (event.metric == null) {
      return { ok: false, error: 'reported tier requires non-null metric' };
    }
    if (event.metric_value == null || event.metric_value < 0) {
      return { ok: false, error: 'reported tier requires metric_value ≥ 0' };
    }
    if (event.metric_value > METRIC_VALUE_MAX) {
      return {
        ok: false,
        error: `metric_value ${event.metric_value} exceeds cap of ${METRIC_VALUE_MAX}`,
      };
    }
    if (event.model != null) {
      return { ok: false, error: 'reported tier forbids model' };
    }
    if (event.tokens_in !== 0 || event.tokens_out !== 0) {
      return {
        ok: false,
        error: 'reported tier requires tokens_in = 0 and tokens_out = 0',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    error: `unknown instrumentation_tier: ${String(event.instrumentation_tier)}`,
  };
}
