// Anomaly alert payload builder. Translates an `AnomalyEvent` row into
// the wire-shape the alert delivery pipeline (webhook / email / Slack
// via builder-alert.ts) consumes. Pure — no I/O. Lives next to
// alerts/payloads.ts so future rule types and anomaly types share one
// neighborhood.

import crypto from 'node:crypto';
import {
  WebhookEventType,
  type AnomalyDetectedPayload,
  type AnomalyEvent,
} from '@pylva/shared';

export function buildAnomalyDetectedPayload(
  builderId: string,
  anomaly: AnomalyEvent,
): AnomalyDetectedPayload {
  // Diagnosis + recommendation already only contain set keys at the
  // producer (margin-diagnosis.ts / recommendations.ts); plain spread
  // suffices and avoids 7× conditional-spread boilerplate.
  return {
    id: crypto.randomUUID(),
    type: WebhookEventType.ANOMALY_DETECTED,
    builder_id: builderId,
    timestamp: new Date().toISOString(),
    data: {
      anomaly_id: anomaly.id,
      customer_id: anomaly.customer_id,
      source_type: anomaly.source_type,
      severity: anomaly.severity,
      actual_value: anomaly.actual_value,
      baseline_value: anomaly.baseline_value,
      delta_pct: anomaly.delta_pct,
      period_start: anomaly.period_start.toISOString(),
      period_end: anomaly.period_end.toISOString(),
      diagnosis: { ...anomaly.diagnosis },
      recommendation: { ...anomaly.recommendation },
    },
  };
}
