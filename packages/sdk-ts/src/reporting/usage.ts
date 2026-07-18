// Non-LLM usage reporting — reportUsage() emits a reported-tier event.
// The ingest route multiplies metric_value by the builder's custom_pricing
// rate (or marks pricing_status='needs_input' until rate is set).

import { randomUUID } from 'node:crypto';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
} from '@pylva/shared/telemetry-values';
import { currentContext } from '../core/context.js';
import { enqueue } from '../core/telemetry.js';

export interface ReportUsageInput {
  tool: string;
  metric: string;
  value: number;
  customer_id?: string;
  step?: string;
}

const METRIC_VALUE_MAX = 1_000_000_000;

export function reportUsage(input: ReportUsageInput): void {
  if (input.value > METRIC_VALUE_MAX) {
    console.warn(
      `[pylva] reportUsage value ${input.value} exceeds cap of ${METRIC_VALUE_MAX}; ingest will reject`,
    );
  }

  const ctx = currentContext();
  const customerId = input.customer_id ?? ctx?.customer_id;
  if (!customerId) {
    console.warn('[pylva] reportUsage: no customer_id (pass in opts or call inside track())');
    return;
  }

  enqueue({
    run_id: ctx?.run_id ?? randomUUID(),
    parent_run_id: ctx?.parent_run_id ?? null,
    trace_id: ctx?.trace_id ?? randomUUID(),
    span_id: randomUUID(),
    parent_span_id: ctx?.span_id ?? null,
    customer_id: customerId,
    step_name: input.step ?? ctx?.step_name ?? null,
    model: null,
    provider: null,
    tokens_in: 0,
    tokens_out: 0,
    latency_ms: 0,
    tool_name: input.tool,
    status: EventStatus.SUCCESS,
    framework: ctx?.framework ?? Framework.NONE,
    instrumentation_tier: InstrumentationTier.REPORTED,
    cost_source: CostSource.CONFIGURED,
    metric: input.metric,
    metric_value: input.value,
    stream_aborted: false,
    abort_savings_usd: 0,
    timestamp: new Date().toISOString(),
  });
}
