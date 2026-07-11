// Shared event-factory for LLM wrappers. Fills all the constant fields so
// each wrapper only specifies what it knows: provider, model, token counts,
// latency, status, optional tool_name, optional token_count_source.

import { randomUUID } from 'node:crypto';
import {
  CostSource,
  EventStatus,
  Framework,
  InstrumentationTier,
  Provider,
  TokenCountSource,
  type TelemetryEvent,
} from '@pylva/shared';
import { currentContext } from '../core/context.js';

export interface BuildLlmEventInput {
  provider: string | null;
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  status: EventStatus;
  tokenCountSource?: TokenCountSource | undefined;
  stepNameFallback?: string | undefined;
  toolName?: string | null | undefined;
}

// Returns the shape the telemetry exporter expects — `Omit<TelemetryEvent, 'schema_version' | 'sdk_version'>`.
export function buildLlmEvent(
  input: BuildLlmEventInput,
): Omit<TelemetryEvent, 'schema_version' | 'sdk_version'> {
  const ctx = currentContext();
  return {
    run_id: ctx?.run_id ?? randomUUID(),
    parent_run_id: ctx?.parent_run_id ?? null,
    trace_id: ctx?.trace_id ?? randomUUID(),
    span_id: randomUUID(),
    parent_span_id: ctx?.span_id ?? null,
    customer_id: ctx?.customer_id ?? 'anonymous',
    step_name: ctx?.step_name ?? input.stepNameFallback ?? null,
    model: input.model,
    provider: input.provider ?? Provider.OTHER,
    tokens_in: input.tokensIn,
    tokens_out: input.tokensOut,
    latency_ms: input.latencyMs,
    tool_name: input.toolName ?? null,
    status: input.status,
    framework: ctx?.framework ?? Framework.NONE,
    instrumentation_tier: InstrumentationTier.SDK_WRAPPER,
    cost_source: CostSource.AUTO,
    metric: null,
    metric_value: null,
    stream_aborted: input.status === EventStatus.ABORTED,
    abort_savings_usd: 0,
    timestamp: new Date().toISOString(),
    ...(input.tokenCountSource !== undefined
      ? { metadata: { token_count_source: input.tokenCountSource } }
      : {}),
  };
}
