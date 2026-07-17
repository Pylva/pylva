import { NUMERIC_44_18_PATTERN, UINT32_MAX } from '@pylva/shared';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const UTC_MILLISECOND_PATTERN =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;
const CUSTOMER_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE_PATTERN = /[\uD800-\uDFFF]/u;
const PRINTABLE_ASCII_PATTERN = /^[ -~]+$/;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9 _.:/-]+$/;
const COST_SOURCE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

const METADATA_KEYS = new Set([
  'provider_request_id',
  'token_count_source',
  'finish_reason',
  'sdk_version',
  'sdk_language',
  'framework',
  'tool_name',
  'cost_source_slug',
  'pricing_snapshot_hash',
  'usage_snapshot_hash',
]);
const REQUIRED_COMMON_METADATA_KEYS = [
  'sdk_version',
  'sdk_language',
  'framework',
  'pricing_snapshot_hash',
  'usage_snapshot_hash',
] as const;

const PAYLOAD_KEYS = new Set([
  'schema_version',
  'event_id',
  'timestamp',
  'builder_id',
  'reservation_decision_id',
  'operation_id',
  'trace_id',
  'span_id',
  'parent_span_id',
  'customer_id',
  'provider',
  'model',
  'operation',
  'step_name',
  'tokens_in',
  'tokens_out',
  'cost_usd',
  'pricing_status',
  'latency_ms',
  'status',
  'cost_source',
  'instrumentation_tier',
  'metric',
  'metric_value',
  'stream_aborted',
  'abort_savings',
  'is_demo',
  'retention_days',
  'billing_retention_days',
  'metadata',
]);

export class BudgetProjectionPayloadError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Invalid authoritative projection payload field ${field}: ${reason}`);
    this.name = 'BudgetProjectionPayloadError';
    this.field = field;
  }
}

export interface AuthoritativeBudgetCostEventPayload {
  schema_version: '1.6';
  event_id: string;
  timestamp: string;
  builder_id: string;
  reservation_decision_id: string;
  operation_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  customer_id: string;
  provider: string;
  model: string | null;
  operation: 'chat.completions' | 'reported' | 'tool_call';
  step_name: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  pricing_status: 'priced';
  latency_ms: number;
  status: 'success' | 'failure' | 'retry' | 'aborted';
  cost_source: 'auto' | 'configured';
  instrumentation_tier: 'sdk_wrapper' | 'reported';
  metric: string | null;
  metric_value: string | null;
  stream_aborted: boolean;
  abort_savings: string;
  is_demo: boolean;
  retention_days: number;
  billing_retention_days: number;
  metadata: Record<string, string>;
}

export interface AuthoritativeBudgetCostEventRow {
  event_id: string;
  payload_hash: string;
  timestamp: string;
  builder_id: string;
  reservation_decision_id: string;
  operation_id: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  customer_id: string;
  provider: string;
  model: string | null;
  operation: string;
  step_name: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: string;
  pricing_status: 'priced';
  latency_ms: number;
  status: string;
  cost_source: string;
  instrumentation_tier: string;
  metric: string | null;
  metric_value: string | null;
  stream_aborted: 0 | 1;
  abort_savings: string;
  savings_usd: number;
  is_demo: 0 | 1;
  retention_days: number;
  billing_retention_days: number;
  metadata: string;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new BudgetProjectionPayloadError('$', 'must be an object');
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>): void {
  for (const key of Object.keys(value)) {
    if (!PAYLOAD_KEYS.has(key)) {
      throw new BudgetProjectionPayloadError(key, 'is not part of schema 1.6');
    }
  }
  for (const key of PAYLOAD_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new BudgetProjectionPayloadError(key, 'is required');
    }
  }
}

function literal<T extends string>(
  source: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T {
  const value = source[field];
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new BudgetProjectionPayloadError(field, `must be ${allowed.join(' or ')}`);
  }
  return value as T;
}

function uuid(source: Record<string, unknown>, field: string, nullable = false): string | null {
  const value = source[field];
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BudgetProjectionPayloadError(field, 'must be a canonical lowercase UUID');
  }
  return value;
}

function boundedString(
  source: Record<string, unknown>,
  field: string,
  maximum: number,
  nullable = false,
  allowEmpty = false,
): string | null {
  const value = source[field];
  if (nullable && value === null) return null;
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    [...value].length > maximum ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    LONE_SURROGATE_PATTERN.test(value) ||
    (!allowEmpty && value.trim().length === 0)
  ) {
    throw new BudgetProjectionPayloadError(field, `must be a nonblank safe string <= ${maximum}`);
  }
  return value;
}

function uint(
  source: Record<string, unknown>,
  field: string,
  maximum: number = UINT32_MAX,
): number {
  const value = source[field];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new BudgetProjectionPayloadError(field, `must be an integer between 0 and ${maximum}`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function boolean(source: Record<string, unknown>, field: string): boolean {
  const value = source[field];
  if (typeof value !== 'boolean') {
    throw new BudgetProjectionPayloadError(field, 'must be a boolean');
  }
  return value;
}

function decimal(source: Record<string, unknown>, field: string, nullable = false): string | null {
  const value = source[field];
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !NUMERIC_44_18_PATTERN.test(value)) {
    throw new BudgetProjectionPayloadError(field, 'must be a canonical NUMERIC(44,18) string');
  }
  if (value.includes('.') && (value.endsWith('0') || value.endsWith('.'))) {
    throw new BudgetProjectionPayloadError(field, 'must not contain redundant fractional zeros');
  }
  return value;
}

function timestamp(source: Record<string, unknown>): string {
  const value = source['timestamp'];
  if (typeof value !== 'string' || !UTC_MILLISECOND_PATTERN.test(value)) {
    throw new BudgetProjectionPayloadError('timestamp', 'must use canonical UTC milliseconds');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw new BudgetProjectionPayloadError('timestamp', 'must contain a valid calendar instant');
  }
  return value;
}

function metadataString(
  value: unknown,
  field: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    [...value].length > maximum ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    LONE_SURROGATE_PATTERN.test(value)
  ) {
    throw new BudgetProjectionPayloadError(
      `metadata.${field}`,
      `must be a safe string <= ${maximum}`,
    );
  }
  return value;
}

function metadata(
  source: Record<string, unknown>,
  instrumentationTier: 'sdk_wrapper' | 'reported',
): Record<string, string> {
  const raw = source['metadata'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BudgetProjectionPayloadError('metadata', 'must be a plain JSON object');
  }

  let prototype: object | null;
  let keys: (string | symbol)[];
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(raw) as object | null;
    keys = Reflect.ownKeys(raw);
    descriptors = Object.getOwnPropertyDescriptors(raw);
  } catch {
    throw new BudgetProjectionPayloadError('metadata', 'must be an inspectable plain JSON object');
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new BudgetProjectionPayloadError('metadata', 'must be a plain JSON object');
  }

  const result: Record<string, string> = {};
  for (const key of keys) {
    if (typeof key !== 'string' || !METADATA_KEYS.has(key)) {
      throw new BudgetProjectionPayloadError(
        typeof key === 'string' ? `metadata.${key}` : 'metadata',
        'is not an allowed authoritative metadata field',
      );
    }
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      throw new BudgetProjectionPayloadError(
        `metadata.${key}`,
        'must be an enumerable JSON data property',
      );
    }
    const value = descriptor.value as unknown;
    switch (key) {
      case 'provider_request_id':
        result[key] = metadataString(value, key, 255, true);
        break;
      case 'finish_reason':
        result[key] = metadataString(value, key, 100, true);
        break;
      case 'token_count_source':
        if (value !== 'exact' && value !== 'estimated') {
          throw new BudgetProjectionPayloadError(`metadata.${key}`, 'must be exact or estimated');
        }
        result[key] = value;
        break;
      case 'sdk_version': {
        const sdkVersion = metadataString(value, key, 50);
        if (!PRINTABLE_ASCII_PATTERN.test(sdkVersion)) {
          throw new BudgetProjectionPayloadError(
            `metadata.${key}`,
            'must contain printable ASCII only',
          );
        }
        result[key] = sdkVersion;
        break;
      }
      case 'sdk_language':
        if (value !== 'python' && value !== 'typescript' && value !== 'unknown') {
          throw new BudgetProjectionPayloadError(
            `metadata.${key}`,
            'must be python, typescript, or unknown',
          );
        }
        result[key] = value;
        break;
      case 'framework':
        if (
          value !== 'langgraph' &&
          value !== 'crewai' &&
          value !== 'mastra' &&
          value !== 'openai-agents' &&
          value !== 'pydantic-ai' &&
          value !== 'none'
        ) {
          throw new BudgetProjectionPayloadError(`metadata.${key}`, 'has an unsupported framework');
        }
        result[key] = value;
        break;
      case 'tool_name': {
        const toolName = metadataString(value, key, 200);
        if (!TOOL_NAME_PATTERN.test(toolName)) {
          throw new BudgetProjectionPayloadError(`metadata.${key}`, 'has unsafe characters');
        }
        result[key] = toolName;
        break;
      }
      case 'cost_source_slug':
        if (typeof value !== 'string' || !COST_SOURCE_SLUG_PATTERN.test(value)) {
          throw new BudgetProjectionPayloadError(
            `metadata.${key}`,
            'must be a canonical cost-source slug',
          );
        }
        result[key] = value;
        break;
      case 'pricing_snapshot_hash':
      case 'usage_snapshot_hash':
        if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
          throw new BudgetProjectionPayloadError(
            `metadata.${key}`,
            'must be a lowercase SHA-256 digest',
          );
        }
        result[key] = value;
        break;
    }
  }

  for (const key of REQUIRED_COMMON_METADATA_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(result, key)) {
      throw new BudgetProjectionPayloadError(`metadata.${key}`, 'is required');
    }
  }
  if (instrumentationTier === 'reported') {
    for (const key of ['tool_name', 'cost_source_slug'] as const) {
      if (!Object.prototype.hasOwnProperty.call(result, key)) {
        throw new BudgetProjectionPayloadError(`metadata.${key}`, 'is required for reported usage');
      }
    }
  } else if (
    Object.prototype.hasOwnProperty.call(result, 'tool_name') ||
    Object.prototype.hasOwnProperty.call(result, 'cost_source_slug')
  ) {
    throw new BudgetProjectionPayloadError(
      'metadata',
      'LLM usage must not contain tool identity metadata',
    );
  }

  return result;
}

export function parseAuthoritativeBudgetCostEventPayload(
  input: unknown,
): AuthoritativeBudgetCostEventPayload {
  const source = record(input);
  exactKeys(source);

  const builderId = uuid(source, 'builder_id')!;
  const customerId = boundedString(source, 'customer_id', 292)!;
  if (!customerId.startsWith(`${builderId}:`) || !CUSTOMER_PATTERN.test(customerId.slice(37))) {
    throw new BudgetProjectionPayloadError(
      'customer_id',
      'must contain the builder prefix and a valid external customer ID',
    );
  }

  const retentionDays = uint(source, 'retention_days', 18_250);
  const billingRetentionDays = uint(source, 'billing_retention_days', 18_250);
  if (retentionDays < 1 || billingRetentionDays < retentionDays) {
    throw new BudgetProjectionPayloadError(
      'billing_retention_days',
      'must be at least retention_days and both must be positive',
    );
  }

  const instrumentationTier = literal(source, 'instrumentation_tier', ['sdk_wrapper', 'reported']);

  const payload: AuthoritativeBudgetCostEventPayload = {
    schema_version: literal(source, 'schema_version', ['1.6']),
    event_id: uuid(source, 'event_id')!,
    timestamp: timestamp(source),
    builder_id: builderId,
    reservation_decision_id: uuid(source, 'reservation_decision_id')!,
    operation_id: uuid(source, 'operation_id')!,
    trace_id: uuid(source, 'trace_id')!,
    span_id: uuid(source, 'span_id')!,
    parent_span_id: uuid(source, 'parent_span_id', true),
    customer_id: customerId,
    provider: boundedString(source, 'provider', 255)!,
    model: boundedString(source, 'model', 255, true),
    operation: literal(source, 'operation', ['chat.completions', 'reported', 'tool_call']),
    step_name: boundedString(source, 'step_name', 200, true, true),
    tokens_in: uint(source, 'tokens_in'),
    tokens_out: uint(source, 'tokens_out'),
    cost_usd: decimal(source, 'cost_usd')!,
    pricing_status: literal(source, 'pricing_status', ['priced']),
    latency_ms: uint(source, 'latency_ms'),
    status: literal(source, 'status', ['success', 'failure', 'retry', 'aborted']),
    cost_source: literal(source, 'cost_source', ['auto', 'configured']),
    instrumentation_tier: instrumentationTier,
    metric: boundedString(source, 'metric', 100, true),
    metric_value: decimal(source, 'metric_value', true),
    stream_aborted: boolean(source, 'stream_aborted'),
    abort_savings: decimal(source, 'abort_savings')!,
    is_demo: boolean(source, 'is_demo'),
    retention_days: retentionDays,
    billing_retention_days: billingRetentionDays,
    metadata: metadata(source, instrumentationTier),
  };

  if (payload.abort_savings !== '0') {
    throw new BudgetProjectionPayloadError('abort_savings', 'must be zero for controlled usage');
  }
  if (payload.instrumentation_tier === 'sdk_wrapper') {
    if (
      payload.operation !== 'chat.completions' ||
      payload.model === null ||
      payload.metric !== null ||
      payload.metric_value !== null
    ) {
      throw new BudgetProjectionPayloadError(
        'instrumentation_tier',
        'sdk_wrapper rows must have LLM dimensions only',
      );
    }
  } else if (
    payload.operation !== 'reported' ||
    payload.cost_source !== 'configured' ||
    payload.model !== null ||
    payload.tokens_in !== 0 ||
    payload.tokens_out !== 0 ||
    payload.metric === null ||
    payload.metric_value === null
  ) {
    throw new BudgetProjectionPayloadError(
      'instrumentation_tier',
      'reported rows must have configured tool dimensions only',
    );
  }

  return payload;
}

export function authoritativePayloadToClickHouseRow(
  payload: AuthoritativeBudgetCostEventPayload,
  payloadHash: string,
): AuthoritativeBudgetCostEventRow {
  if (!SHA256_PATTERN.test(payloadHash)) {
    throw new BudgetProjectionPayloadError('payload_hash', 'must be a lowercase SHA-256 digest');
  }

  return {
    event_id: payload.event_id,
    payload_hash: payloadHash,
    timestamp: payload.timestamp.replace('T', ' ').slice(0, -1),
    builder_id: payload.builder_id,
    reservation_decision_id: payload.reservation_decision_id,
    operation_id: payload.operation_id,
    trace_id: payload.trace_id,
    span_id: payload.span_id,
    parent_span_id: payload.parent_span_id,
    customer_id: payload.customer_id,
    provider: payload.provider,
    model: payload.model,
    operation: payload.operation,
    step_name: payload.step_name,
    tokens_in: payload.tokens_in,
    tokens_out: payload.tokens_out,
    cost_usd: payload.cost_usd,
    pricing_status: payload.pricing_status,
    latency_ms: payload.latency_ms,
    status: payload.status,
    cost_source: payload.cost_source,
    instrumentation_tier: payload.instrumentation_tier,
    metric: payload.metric,
    metric_value: payload.metric_value,
    stream_aborted: payload.stream_aborted ? 1 : 0,
    abort_savings: payload.abort_savings,
    savings_usd: 0,
    is_demo: payload.is_demo ? 1 : 0,
    retention_days: payload.retention_days,
    billing_retention_days: payload.billing_retention_days,
    metadata: JSON.stringify(payload.metadata),
  };
}
