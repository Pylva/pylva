// /openapi.json — OpenAPI 3.1 description of the public SDK-facing API.
// Facts are transcribed from code, not the written spec:
//   wire schemas    packages/shared/src/types/telemetry.ts + types/rules.ts
//   route behavior  src/app/api/v1/{events,rules,pricing,budget/sync}/route.ts
//   ingest checks   src/lib/ingest/{public-handler,semantic-validation,dedup}.ts
//   error envelope  src/lib/errors.ts + packages/shared/src/types/errors.ts
//   auth + limits   src/lib/auth/api-key.ts + src/lib/auth/middleware.ts

import {
  BUDGET_CONTROL_SCHEMA_VERSION,
  BudgetBypassReason,
  BudgetControlMode,
  BudgetControlWarningCode,
  BudgetReleaseReason,
  BudgetReservationState,
  BudgetRulePeriod,
  BudgetRuleScope,
  BudgetUnavailableReason,
  BuilderTier,
  ControlledUsageKind,
  CostSource,
  DEFAULT_RESERVATION_TTL_SECONDS,
  ErrorCode,
  EventCapWindowSource,
  EventStatus,
  Framework,
  IngestWarningCode,
  InstrumentationTier,
  PROVIDER_MODEL_MAX_LENGTH,
  Provider,
  ReserveDecision,
  RuleEnforcement,
  RulePeriod,
  RuleScope,
  RuleStatus,
  RuleType,
  TokenCountSource,
} from '@pylva/shared';
// Semantic caps enforced per event by src/lib/ingest/semantic-validation.ts.
import { MAX_STORABLE_COST_USD, UINT32_MAX } from '../clickhouse/decimal-limits.js';
import { PYLVA_DOCS_URL, PYLVA_SLACK_SUPPORT_URL } from '../public-links.js';

// Length + charset constraints mirror the Valibot schemas in
// packages/shared/src/types/telemetry.ts (spec §4.10).
const STEP_NAME_PATTERN = '^[a-zA-Z0-9 _\\-.:/]*$';
const MODEL_PATTERN = '^[a-zA-Z0-9\\-./]*$';
const CUSTOMER_ID_PATTERN = '^[a-zA-Z0-9_\\-]+$';
const CONTROL_DECIMAL_PATTERN = '^(?:0|[1-9][0-9]{0,19})(?:\\.[0-9]{1,18})?$';
const CONTROL_POST_PROVIDER_DECIMAL_PATTERN = '^(?:0|[1-9][0-9]{0,25})(?:\\.[0-9]{1,18})?$';
// Matches the shared contract's explicit blank/control-character policy.
// Lone escaped surrogates are additionally rejected by the runtime schemas;
// JSON Schema regex engines cannot express that check portably without also
// rejecting valid astral characters.
const CONTROL_STORE_SAFE_IDENTIFIER_PATTERN =
  '^(?![\\u0009-\\u000D\\u0020\\u0085\\u00A0\\u1680\\u2000-\\u200A' +
  '\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]*$)[^\\u0000-\\u001F\\u007F]*$';

function schemaRef(name: string): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function buildBudgetControlSchemas() {
  const uuid = {
    type: 'string',
    format: 'uuid',
    description: 'UUID; accepted uppercase input is normalized to lowercase.',
  };
  const timestamp = {
    type: 'string',
    format: 'date-time',
    description: 'Canonical UTC Z timestamp with at most millisecond precision.',
  };
  const decimal = {
    type: 'string',
    pattern: CONTROL_DECIMAL_PATTERN,
    description:
      'Canonical nonnegative NUMERIC(38,18) decimal string. No signs, ' +
      'scientific notation, whitespace, or redundant leading zeroes.',
  };
  const postProviderDecimal = {
    type: 'string',
    pattern: CONTROL_POST_PROVIDER_DECIMAL_PATTERN,
    description: 'Canonical nonnegative post-provider NUMERIC(44,18) decimal string.',
  };
  const warningArray = {
    type: 'array',
    items: schemaRef('BudgetControlWarning'),
  };
  const reserveCommonRequired = [
    'schema_version',
    'mode',
    'operation_id',
    'customer_id',
    'trace_id',
    'span_id',
    'parent_span_id',
    'step_name',
  ];
  const reserveCommonProperties = {
    schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
    mode: { type: 'string', enum: Object.values(BudgetControlMode) },
    operation_id: uuid,
    customer_id: {
      type: 'string',
      minLength: 1,
      maxLength: 255,
      pattern: CUSTOMER_ID_PATTERN,
    },
    trace_id: uuid,
    span_id: uuid,
    parent_span_id: { oneOf: [uuid, { type: 'null' }] },
    step_name: {
      type: ['string', 'null'],
      maxLength: 200,
      pattern: STEP_NAME_PATTERN,
    },
    framework: {
      type: 'string',
      enum: Object.values(Framework),
      default: Framework.NONE,
    },
    reservation_ttl_seconds: {
      type: 'integer',
      minimum: 30,
      maximum: 3600,
      default: DEFAULT_RESERVATION_TTL_SECONDS,
    },
  };
  const commitCommonRequired = ['schema_version', 'status', 'latency_ms', 'stream_aborted'];
  const commitCommonProperties = {
    schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
    status: {
      type: 'string',
      enum: [EventStatus.SUCCESS, EventStatus.FAILURE, EventStatus.RETRY, EventStatus.ABORTED],
    },
    latency_ms: { type: 'integer', minimum: 0, maximum: UINT32_MAX },
    stream_aborted: { type: 'boolean' },
  };
  const bypassedResponse = (
    reason: string,
    decisionId: object,
    wouldHaveDenied: object,
    warnings: object = warningArray,
  ) => ({
    type: 'object',
    required: [
      'schema_version',
      'decision',
      'allowed',
      'decision_id',
      'operation_id',
      'reason',
      'would_have_denied',
      'warnings',
    ],
    properties: {
      schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
      decision: { type: 'string', const: ReserveDecision.BYPASSED },
      allowed: { type: 'boolean', const: true },
      decision_id: decisionId,
      operation_id: uuid,
      reason: { type: 'string', const: reason },
      would_have_denied: wouldHaveDenied,
      warnings,
    },
  });

  return {
    BudgetProviderModelIdentifier: {
      type: 'string',
      minLength: 1,
      maxLength: PROVIDER_MODEL_MAX_LENGTH,
      pattern: CONTROL_STORE_SAFE_IDENTIFIER_PATTERN,
      description:
        'Exact provider or model runtime identifier. Unicode and punctuation are allowed; ' +
        'blank-only values, control characters, and lone Unicode surrogates are rejected.',
    },
    BudgetControlCapabilitiesResponse: {
      type: 'object',
      required: [
        'schema_version',
        'control_enabled',
        'min_reservation_ttl_seconds',
        'default_reservation_ttl_seconds',
        'max_reservation_ttl_seconds',
        'server_time',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        control_enabled: { type: 'boolean' },
        min_reservation_ttl_seconds: { type: 'integer', const: 30 },
        default_reservation_ttl_seconds: {
          type: 'integer',
          const: DEFAULT_RESERVATION_TTL_SECONDS,
        },
        max_reservation_ttl_seconds: { type: 'integer', const: 3600 },
        server_time: timestamp,
      },
    },
    BudgetControlWarning: {
      type: 'object',
      required: ['code', 'rule_id', 'limit_usd', 'projected_usd'],
      properties: {
        code: { type: 'string', const: BudgetControlWarningCode.ADVISORY_BUDGET_EXCEEDED },
        rule_id: uuid,
        limit_usd: decimal,
        projected_usd: {
          ...decimal,
          description: 'Canonical projected spend; greater than limit_usd for this warning.',
        },
      },
    },
    BudgetRuleSnapshot: {
      description: 'Immutable deciding rule snapshot. period_end is later than period_start.',
      oneOf: [
        {
          type: 'object',
          required: ['rule_id', 'scope', 'customer_id', 'period', 'period_start', 'period_end'],
          properties: {
            rule_id: uuid,
            scope: { type: 'string', const: BudgetRuleScope.PER_CUSTOMER },
            customer_id: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: CUSTOMER_ID_PATTERN,
            },
            period: { type: 'string', enum: Object.values(BudgetRulePeriod) },
            period_start: timestamp,
            period_end: timestamp,
          },
        },
        {
          type: 'object',
          required: ['rule_id', 'scope', 'customer_id', 'period', 'period_start', 'period_end'],
          properties: {
            rule_id: uuid,
            scope: { type: 'string', const: BudgetRuleScope.POOLED },
            customer_id: { type: 'null' },
            period: { type: 'string', enum: Object.values(BudgetRulePeriod) },
            period_start: timestamp,
            period_end: timestamp,
          },
        },
      ],
    },
    LlmReserveUsageRequest: {
      type: 'object',
      additionalProperties: false,
      required: [
        ...reserveCommonRequired,
        'kind',
        'provider',
        'model',
        'estimated_input_tokens',
        'max_output_tokens',
      ],
      properties: {
        ...reserveCommonProperties,
        kind: { type: 'string', const: ControlledUsageKind.LLM },
        provider: schemaRef('BudgetProviderModelIdentifier'),
        model: schemaRef('BudgetProviderModelIdentifier'),
        estimated_input_tokens: {
          type: 'integer',
          minimum: 0,
          maximum: UINT32_MAX,
        },
        max_output_tokens: { type: 'integer', minimum: 0, maximum: UINT32_MAX },
      },
    },
    ToolReserveUsageRequest: {
      type: 'object',
      additionalProperties: false,
      required: [
        ...reserveCommonRequired,
        'kind',
        'cost_source_slug',
        'tool_name',
        'metric',
        'maximum_value',
      ],
      properties: {
        ...reserveCommonProperties,
        kind: { type: 'string', const: ControlledUsageKind.TOOL },
        cost_source_slug: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: '^[a-z0-9][a-z0-9-]*$',
        },
        tool_name: {
          type: 'string',
          minLength: 1,
          maxLength: 200,
          pattern: STEP_NAME_PATTERN,
        },
        metric: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          pattern: CONTROL_STORE_SAFE_IDENTIFIER_PATTERN,
          description: 'Non-blank, control-character-free metric name.',
        },
        maximum_value: decimal,
      },
    },
    ReserveUsageRequest: {
      discriminator: { propertyName: 'kind' },
      oneOf: [schemaRef('LlmReserveUsageRequest'), schemaRef('ToolReserveUsageRequest')],
    },
    ReservedUsageResponse: {
      type: 'object',
      required: [
        'schema_version',
        'decision',
        'allowed',
        'decision_id',
        'operation_id',
        'reservation_id',
        'state',
        'reserved_usd',
        'remaining_usd',
        'expires_at',
        'warnings',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        decision: { type: 'string', const: ReserveDecision.RESERVED },
        allowed: { type: 'boolean', const: true },
        decision_id: uuid,
        operation_id: uuid,
        reservation_id: uuid,
        state: { type: 'string', const: BudgetReservationState.RESERVED },
        reserved_usd: decimal,
        remaining_usd: { oneOf: [decimal, { type: 'null' }] },
        expires_at: timestamp,
        warnings: warningArray,
      },
    },
    DeniedUsageResponse: {
      type: 'object',
      description:
        'Expected refusal. protected spend plus requested_usd exceeds limit_usd; ' +
        'remaining_usd is the pre-request remainder.',
      required: [
        'schema_version',
        'decision',
        'allowed',
        'decision_id',
        'operation_id',
        'state',
        'deciding_rule',
        'committed_usd',
        'reserved_usd',
        'unresolved_usd',
        'requested_usd',
        'limit_usd',
        'remaining_usd',
        'warnings',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        decision: { type: 'string', const: ReserveDecision.DENIED },
        allowed: { type: 'boolean', const: false },
        decision_id: uuid,
        operation_id: uuid,
        state: { type: 'string', const: BudgetReservationState.REFUSED },
        deciding_rule: schemaRef('BudgetRuleSnapshot'),
        committed_usd: decimal,
        reserved_usd: decimal,
        unresolved_usd: decimal,
        requested_usd: decimal,
        limit_usd: decimal,
        remaining_usd: decimal,
        warnings: warningArray,
      },
    },
    BypassedUsageResponse: {
      discriminator: { propertyName: 'reason' },
      oneOf: [
        bypassedResponse(
          BudgetBypassReason.CONTROL_DISABLED,
          { type: 'null' },
          { type: 'null' },
          { ...warningArray, maxItems: 0 },
        ),
        bypassedResponse(
          BudgetBypassReason.NO_APPLICABLE_BUDGET,
          uuid,
          { type: 'null' },
          { ...warningArray, maxItems: 0 },
        ),
        bypassedResponse(BudgetBypassReason.SHADOW_WOULD_ALLOW, uuid, {
          type: 'boolean',
          const: false,
        }),
        bypassedResponse(BudgetBypassReason.SHADOW_WOULD_DENY, uuid, {
          type: 'boolean',
          const: true,
        }),
        bypassedResponse(
          BudgetBypassReason.SHADOW_CONTROL_UNAVAILABLE,
          { oneOf: [uuid, { type: 'null' }] },
          { type: 'null' },
          { ...warningArray, maxItems: 0 },
        ),
      ],
    },
    UnavailableUsageResponse: {
      type: 'object',
      required: [
        'schema_version',
        'decision',
        'allowed',
        'decision_id',
        'operation_id',
        'reason',
        'retryable',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        decision: { type: 'string', const: ReserveDecision.UNAVAILABLE },
        allowed: { type: 'boolean', const: false },
        decision_id: { oneOf: [uuid, { type: 'null' }] },
        operation_id: uuid,
        reason: { type: 'string', enum: Object.values(BudgetUnavailableReason) },
        retryable: { type: 'boolean' },
      },
    },
    ReserveUsageResponse: {
      description:
        'All normal allow, refuse, bypass, and control-unavailable decisions return HTTP 200.',
      discriminator: { propertyName: 'decision' },
      oneOf: [
        schemaRef('ReservedUsageResponse'),
        schemaRef('DeniedUsageResponse'),
        schemaRef('BypassedUsageResponse'),
        schemaRef('UnavailableUsageResponse'),
      ],
    },
    LlmCommitUsageRequest: {
      type: 'object',
      additionalProperties: false,
      required: [...commitCommonRequired, 'kind', 'actual_input_tokens', 'actual_output_tokens'],
      properties: {
        ...commitCommonProperties,
        kind: { type: 'string', const: ControlledUsageKind.LLM },
        actual_input_tokens: { type: 'integer', minimum: 0, maximum: UINT32_MAX },
        actual_output_tokens: { type: 'integer', minimum: 0, maximum: UINT32_MAX },
      },
    },
    ToolCommitUsageRequest: {
      type: 'object',
      additionalProperties: false,
      required: [...commitCommonRequired, 'kind', 'actual_value'],
      properties: {
        ...commitCommonProperties,
        kind: { type: 'string', const: ControlledUsageKind.TOOL },
        actual_value: decimal,
      },
    },
    CommitUsageRequest: {
      discriminator: { propertyName: 'kind' },
      oneOf: [schemaRef('LlmCommitUsageRequest'), schemaRef('ToolCommitUsageRequest')],
    },
    CommitUsageResponse: {
      type: 'object',
      description:
        'Settlement result. released_usd and overage_usd exactly reconcile reserved_usd ' +
        'against actual_usd.',
      required: [
        'schema_version',
        'state',
        'reservation_id',
        'operation_id',
        'reserved_usd',
        'actual_usd',
        'released_usd',
        'overage_usd',
        'budget_exceeded_after_commit',
        'committed_at',
        'idempotent_replay',
        'late',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        state: { type: 'string', const: BudgetReservationState.COMMITTED },
        reservation_id: uuid,
        operation_id: uuid,
        reserved_usd: decimal,
        actual_usd: postProviderDecimal,
        released_usd: decimal,
        overage_usd: postProviderDecimal,
        budget_exceeded_after_commit: { type: 'boolean' },
        committed_at: timestamp,
        idempotent_replay: { type: 'boolean' },
        late: { type: 'boolean' },
      },
    },
    ReleaseUsageRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['schema_version', 'reason'],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        reason: { type: 'string', enum: Object.values(BudgetReleaseReason) },
      },
    },
    ReleaseUsageResponse: {
      type: 'object',
      required: [
        'schema_version',
        'state',
        'reservation_id',
        'operation_id',
        'released_usd',
        'released_at',
        'idempotent_replay',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        state: { type: 'string', const: BudgetReservationState.RELEASED },
        reservation_id: uuid,
        operation_id: uuid,
        released_usd: decimal,
        released_at: timestamp,
        idempotent_replay: { type: 'boolean' },
      },
    },
    ExtendUsageRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['schema_version', 'extension_id', 'extend_by_seconds'],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        extension_id: uuid,
        extend_by_seconds: { type: 'integer', minimum: 30, maximum: 3600 },
      },
    },
    ExtendUsageResponse: {
      type: 'object',
      required: [
        'schema_version',
        'state',
        'reservation_id',
        'operation_id',
        'extension_id',
        'expires_at',
        'idempotent_replay',
      ],
      properties: {
        schema_version: { type: 'string', const: BUDGET_CONTROL_SCHEMA_VERSION },
        state: { type: 'string', const: BudgetReservationState.RESERVED },
        reservation_id: uuid,
        operation_id: uuid,
        extension_id: uuid,
        expires_at: timestamp,
        idempotent_replay: { type: 'boolean' },
      },
    },
  };
}

export function buildOpenApiDocument() {
  const errorContent = {
    'application/json': { schema: schemaRef('ErrorResponse') },
  };

  const noStoreHeaders = {
    'Cache-Control': {
      description: 'Always no-store because this is live tenant control state.',
      schema: { type: 'string', const: 'no-store' },
    },
  };

  const sdkIdentityParameters = [
    { $ref: '#/components/parameters/SdkVersionHeader' },
    { $ref: '#/components/parameters/SdkLanguageHeader' },
  ];

  const sharedErrorResponses = {
    '400': { $ref: '#/components/responses/BadRequest' },
    '401': { $ref: '#/components/responses/Unauthorized' },
    '403': { $ref: '#/components/responses/Forbidden' },
    '429': { $ref: '#/components/responses/RateLimited' },
  };

  const budgetControlBaseErrors = {
    '401': { $ref: '#/components/responses/BudgetControlUnauthorized' },
    '403': { $ref: '#/components/responses/BudgetControlForbidden' },
    '429': { $ref: '#/components/responses/BudgetControlRateLimited' },
    '500': { $ref: '#/components/responses/InternalError' },
    '503': { $ref: '#/components/responses/BudgetControlUnavailable' },
  };

  return {
    openapi: '3.1.0',
    info: {
      title: 'Pylva Public API',
      version: '1.0.0',
      description:
        'The SDK-facing telemetry endpoints for Pylva: events ingest, ' +
        'rules sync, pricing lookup, budget reconciliation, authoritative ' +
        'budget reservation control, and key/plan identification. These ' +
        'ten endpoints are the entire public ' +
        'surface; the dashboard API is private and not documented here.',
      contact: { url: PYLVA_SLACK_SUPPORT_URL },
      license: { name: 'MIT', identifier: 'MIT' },
    },
    externalDocs: {
      description: 'Pylva documentation and quickstart',
      url: PYLVA_DOCS_URL,
    },
    servers: [
      {
        url: 'https://api.pylva.com',
        description: 'Pylva Cloud. Self-hosted deployments substitute their own origin.',
      },
    ],
    security: [{ ApiKeyAuth: [] }],
    paths: {
      '/api/v1/events': {
        post: {
          operationId: 'ingestEvents',
          summary: 'Ingest a batch of telemetry events',
          description:
            'Accepts 1-100 telemetry events per request. Validation is ' +
            'two-phase: a malformed body or wire-schema violation rejects ' +
            'the whole request with 400, while per-event semantic failures ' +
            '(timestamp beyond the 15-minute clock-skew allowance, ' +
            'instrumentation-tier field mismatches, oversized token counts) ' +
            'reject only the offending events, reported in errors[] of a ' +
            '200 response. span_id is the idempotency key: a span_id ' +
            'repeated within the batch or already ingested by an earlier ' +
            'batch (server-side dedup window of roughly two hours, behind ' +
            "the SDK's own LRU) is dropped silently and counted in neither " +
            'accepted nor rejected, so retrying a batch after a network ' +
            'failure is safe. Rate limit: 1000 requests per minute per API ' +
            'key, shared with the other Agent SDK endpoints; 429 ' +
            'responses carry Retry-After.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: schemaRef('IngestRequest') },
            },
          },
          responses: {
            '200': {
              description:
                'Ingest result. Returned even when some or all events were ' +
                'rejected semantically; only request-level failures use 4xx.',
              content: {
                'application/json': { schema: schemaRef('IngestResponse') },
              },
            },
            ...sharedErrorResponses,
          },
        },
      },
      '/api/v1/rules': {
        get: {
          operationId: 'syncRules',
          summary: 'Fetch pre-call rules for the SDK cache',
          description:
            'Returns the rules the SDK engine can act on before a provider ' +
            'call: active, enabled, pre_call rules only (drafts, disabled ' +
            'rules, and post_call rules are excluded). Cache the response ' +
            'for ttl_seconds (constant 60) and re-fetch after expiry. No ' +
            'query parameters.',
          responses: {
            '200': {
              description: 'Current pre-call rule set.',
              content: {
                'application/json': { schema: schemaRef('RulesResponse') },
              },
            },
            ...sharedErrorResponses,
          },
        },
      },
      '/api/v1/pricing': {
        get: {
          operationId: 'getPricing',
          summary: 'Fetch the global LLM price book',
          description:
            'Returns the currently-effective global price list (USD per 1M ' +
            'tokens) used for automatic cost calculation. Takes no query ' +
            'parameters; any supplied (for example a providers filter) are ' +
            'ignored and the full price book is returned. Responses are ' +
            'cacheable for 24 hours and the SDK pricing cache honors that ' +
            'TTL.',
          responses: {
            '200': {
              description: 'Active pricing rows for all providers.',
              headers: {
                'Cache-Control': {
                  description: 'public, max-age=86400 (cache for 24 hours).',
                  schema: { type: 'string' },
                },
              },
              content: {
                'application/json': { schema: schemaRef('PricingResponse') },
              },
            },
            ...sharedErrorResponses,
          },
        },
      },
      '/api/v1/budget/sync': {
        post: {
          operationId: 'syncBudgets',
          summary: 'Reconcile SDK budget accumulators',
          description:
            "Reconciles the SDK's local budget accumulators against " +
            'server-side spend. Send up to 500 entries keyed by (rule_id, ' +
            'scope, customer_id, period_start); each result echoes its key ' +
            'and returns server_total_usd, which replaces the local ' +
            'accumulator, plus budget_remaining_usd and a budget_exceeded ' +
            'flag.',
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: schemaRef('BudgetSyncRequest') },
            },
          },
          responses: {
            '200': {
              description: 'Reconciled totals for every submitted entry.',
              content: {
                'application/json': { schema: schemaRef('BudgetSyncResponse') },
              },
            },
            ...sharedErrorResponses,
          },
        },
      },
      '/api/v1/budget/capabilities': {
        get: {
          operationId: 'getBudgetControlCapabilities',
          summary: 'Discover authoritative budget-control availability',
          description:
            'Returns the supported control schema and reservation lease ' +
            'bounds. control_enabled is live workspace readiness, not merely ' +
            'client configuration. Invalid or absent optional SDK identity ' +
            'headers are recorded as unknown and do not change authorization.',
          parameters: sdkIdentityParameters,
          responses: {
            '200': {
              description: 'Current control capability and server time.',
              headers: noStoreHeaders,
              content: {
                'application/json': {
                  schema: schemaRef('BudgetControlCapabilitiesResponse'),
                },
              },
            },
            ...budgetControlBaseErrors,
          },
        },
      },
      '/api/v1/budget/reservations': {
        post: {
          operationId: 'reserveBudgetUsage',
          summary: 'Authorize bounded usage before provider dispatch',
          description:
            'The backend prices the bounded LLM or tool intent and atomically ' +
            'evaluates all applicable budgets. Normal reserved, denied, ' +
            'bypassed, and unavailable decisions all return 200. Retrying the ' +
            'same canonical operation request returns its stored decision; ' +
            'reusing operation_id with different input returns 409.',
          parameters: sdkIdentityParameters,
          requestBody: {
            required: true,
            description:
              'Strict UTF-8 JSON, limited to 16 KiB before parsing. Unknown properties are rejected.',
            content: {
              'application/json': { schema: schemaRef('ReserveUsageRequest') },
            },
          },
          responses: {
            '200': {
              description: 'A normal allow/refuse/bypass/unavailable control decision.',
              headers: noStoreHeaders,
              content: {
                'application/json': { schema: schemaRef('ReserveUsageResponse') },
              },
            },
            '400': { $ref: '#/components/responses/BudgetControlBadRequest' },
            '409': { $ref: '#/components/responses/IdempotencyConflict' },
            ...budgetControlBaseErrors,
          },
        },
      },
      '/api/v1/budget/reservations/{id}/commit': {
        post: {
          operationId: 'commitBudgetUsage',
          summary: 'Settle a reservation with actual provider usage',
          description:
            'Atomically replaces held capacity with backend-priced actual ' +
            'usage. A replay of the identical terminal transition returns the ' +
            'stored result; a contradictory terminal transition returns 409.',
          parameters: [
            { $ref: '#/components/parameters/ReservationIdPath' },
            ...sdkIdentityParameters,
          ],
          requestBody: {
            required: true,
            description:
              'Strict UTF-8 JSON, limited to 16 KiB before parsing. Unknown properties are rejected.',
            content: {
              'application/json': { schema: schemaRef('CommitUsageRequest') },
            },
          },
          responses: {
            '200': {
              description: 'Committed settlement, including idempotent replay state.',
              headers: noStoreHeaders,
              content: {
                'application/json': { schema: schemaRef('CommitUsageResponse') },
              },
            },
            '400': { $ref: '#/components/responses/BudgetControlBadRequest' },
            '404': { $ref: '#/components/responses/ResourceNotFound' },
            '409': { $ref: '#/components/responses/BudgetLifecycleConflict' },
            ...budgetControlBaseErrors,
          },
        },
      },
      '/api/v1/budget/reservations/{id}/release': {
        post: {
          operationId: 'releaseBudgetUsage',
          summary: 'Release a definitely uncharged reservation',
          description:
            'Releases held or unresolved capacity only when the provider was ' +
            'definitely not charged. Ambiguous outcomes must not be released. ' +
            'Identical retries return the stored result.',
          parameters: [
            { $ref: '#/components/parameters/ReservationIdPath' },
            ...sdkIdentityParameters,
          ],
          requestBody: {
            required: true,
            description:
              'Strict UTF-8 JSON, limited to 16 KiB before parsing. Unknown properties are rejected.',
            content: {
              'application/json': { schema: schemaRef('ReleaseUsageRequest') },
            },
          },
          responses: {
            '200': {
              description: 'Released settlement, including idempotent replay state.',
              headers: noStoreHeaders,
              content: {
                'application/json': { schema: schemaRef('ReleaseUsageResponse') },
              },
            },
            '400': { $ref: '#/components/responses/BudgetControlBadRequest' },
            '404': { $ref: '#/components/responses/ResourceNotFound' },
            '409': { $ref: '#/components/responses/BudgetLifecycleConflict' },
            ...budgetControlBaseErrors,
          },
        },
      },
      '/api/v1/budget/reservations/{id}/extend': {
        post: {
          operationId: 'extendBudgetUsage',
          summary: 'Extend a live reservation lease',
          description:
            'Extends a still-live reservation by a bounded duration. ' +
            'extension_id gives retries their own idempotency identity. ' +
            'Expired reservations cannot be revived.',
          parameters: [
            { $ref: '#/components/parameters/ReservationIdPath' },
            ...sdkIdentityParameters,
          ],
          requestBody: {
            required: true,
            description:
              'Strict UTF-8 JSON, limited to 16 KiB before parsing. Unknown properties are rejected.',
            content: {
              'application/json': { schema: schemaRef('ExtendUsageRequest') },
            },
          },
          responses: {
            '200': {
              description: 'Extended lease, including idempotent replay state.',
              headers: noStoreHeaders,
              content: {
                'application/json': { schema: schemaRef('ExtendUsageResponse') },
              },
            },
            '400': { $ref: '#/components/responses/BudgetControlBadRequest' },
            '404': { $ref: '#/components/responses/ResourceNotFound' },
            '409': { $ref: '#/components/responses/BudgetLifecycleConflict' },
            ...budgetControlBaseErrors,
          },
        },
      },
      '/api/v1/whoami': {
        get: {
          operationId: 'whoami',
          summary: 'Identify the workspace behind an Agent SDK key',
          description:
            'Returns the workspace, plan tier, key scope, and — when event ' +
            'limits are enforced — current monthly usage for the presented ' +
            'Agent SDK key. Intended for integration setup and automated ' +
            'verification: one call proves the key works and shows what it ' +
            'is attached to. Responses are never cached (Cache-Control: ' +
            'no-store). Rate limit is shared with the other Agent SDK ' +
            'endpoints.',
          responses: {
            '200': {
              description: 'Identity, plan limits, and usage for the key.',
              headers: {
                'Cache-Control': {
                  description: 'no-store (live, tenant-identifying).',
                  schema: { type: 'string' },
                },
              },
              content: {
                'application/json': { schema: schemaRef('WhoamiResponse') },
              },
            },
            ...sharedErrorResponses,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Pylva-Key',
          description:
            'API key created in the dashboard (shown once at creation). ' +
            'Format: pv_live_{keyId}_{randomPart}. Agent SDK keys with the ' +
            'agent_sdk scope cover all ten endpoints in this document. A separate ' +
            'admin_api scope exists for the private custom-pricing ' +
            'surface, which is not documented here; keys presented with ' +
            'the wrong scope receive 403 WRONG_SCOPE. Details: ' +
            `${PYLVA_DOCS_URL}/api/api-keys.md`,
        },
      },
      parameters: {
        SdkVersionHeader: {
          name: 'X-Pylva-SDK-Version',
          in: 'header',
          required: false,
          description:
            'Optional SDK version metadata. Up to 50 printable ASCII characters; ' +
            'missing or invalid values are recorded as unknown.',
          schema: {
            type: 'string',
            minLength: 1,
            maxLength: 50,
            pattern: '^[\\x20-\\x7E]+$',
          },
        },
        SdkLanguageHeader: {
          name: 'X-Pylva-SDK-Language',
          in: 'header',
          required: false,
          description:
            'Optional SDK language metadata. Missing or invalid values are ' +
            'recorded as unknown.',
          schema: { type: 'string', enum: ['python', 'typescript'] },
        },
        ReservationIdPath: {
          name: 'id',
          in: 'path',
          required: true,
          description: 'Reservation UUID; accepted uppercase input is normalized to lowercase.',
          schema: { type: 'string', format: 'uuid' },
        },
      },
      responses: {
        BadRequest: {
          description:
            'Invalid UTF-8, malformed or over-16-KiB JSON, or wire-schema violation (type ' +
            'invalid_request_error, code VALIDATION_ERROR; param holds the ' +
            'offending field path).',
          content: errorContent,
        },
        BudgetControlBadRequest: {
          description:
            'Invalid UTF-8, malformed or over-16-KiB JSON, invalid reservation UUID, or ' +
            'wire-schema violation (type invalid_request_error, code VALIDATION_ERROR).',
          headers: noStoreHeaders,
          content: errorContent,
        },
        Unauthorized: {
          description:
            'Missing or invalid X-Pylva-Key header (type ' +
            'authentication_error, code INVALID_API_KEY).',
          content: errorContent,
        },
        BudgetControlUnauthorized: {
          description:
            'Missing or invalid X-Pylva-Key header (type authentication_error, ' +
            'code INVALID_API_KEY).',
          headers: noStoreHeaders,
          content: errorContent,
        },
        Forbidden: {
          description:
            'The key is valid but lacks the required scope (type ' +
            'authentication_error, code WRONG_SCOPE) — for example an ' +
            'pv_cli_ key calling the telemetry endpoints.',
          content: errorContent,
        },
        BudgetControlForbidden: {
          description:
            'The key is valid but cannot call the authoritative control surface ' +
            '(type authentication_error, code WRONG_SCOPE).',
          headers: noStoreHeaders,
          content: errorContent,
        },
        RateLimited: {
          description:
            'Over the shared telemetry budget of 1000 requests per minute ' +
            'per API key (type rate_limit_error, code RATE_LIMIT_EXCEEDED).',
          headers: {
            'Retry-After': {
              description:
                'Seconds to wait before retrying (currently 60, the ' + 'rate-limit window size).',
              schema: { type: 'integer' },
            },
          },
          content: errorContent,
        },
        ResourceNotFound: {
          description:
            'No reservation with this ID is visible in the authenticated ' +
            'workspace (type invalid_request_error, code RESOURCE_NOT_FOUND). ' +
            'The same response is used for absent and cross-tenant IDs.',
          headers: noStoreHeaders,
          content: errorContent,
        },
        IdempotencyConflict: {
          description:
            'An idempotency identity was reused with a different canonical ' +
            'request (type invalid_request_error, code IDEMPOTENCY_CONFLICT).',
          headers: noStoreHeaders,
          content: errorContent,
        },
        ReservationStateConflict: {
          description:
            'The requested lifecycle operation contradicts the reservation state ' +
            '(type invalid_request_error, code RESERVATION_STATE_CONFLICT).',
          headers: noStoreHeaders,
          content: errorContent,
        },
        BudgetLifecycleConflict: {
          description:
            'The lifecycle request either contradicts the reservation state ' +
            '(RESERVATION_STATE_CONFLICT) or reuses its idempotency identity with ' +
            'different canonical input (IDEMPOTENCY_CONFLICT).',
          headers: noStoreHeaders,
          content: errorContent,
        },
        InternalError: {
          description:
            'A sanitized service failure (type api_error, code INTERNAL_ERROR). ' +
            'Database, provider, request, API-key, and secret details are never reflected.',
          headers: noStoreHeaders,
          content: errorContent,
        },
        BudgetControlUnavailable: {
          description:
            'A sanitized temporary control-ledger readiness failure (type api_error, ' +
            'code INTERNAL_ERROR). Exact cost, database, provider, request, API-key, ' +
            'and secret details are never reflected.',
          headers: noStoreHeaders,
          content: errorContent,
        },
        BudgetControlRateLimited: {
          description:
            'Over the isolated authoritative-control budget of 600 requests per minute ' +
            'per API key (type rate_limit_error, code RATE_LIMIT_EXCEEDED).',
          headers: {
            ...noStoreHeaders,
            'Retry-After': {
              description: 'Seconds to wait; currently the 60-second rate-limit window.',
              schema: { type: 'integer', const: 60 },
            },
          },
          content: errorContent,
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          description: 'Stripe-style error envelope returned for every non-2xx response.',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['type', 'code', 'message'],
              properties: {
                type: {
                  type: 'string',
                  enum: [
                    'invalid_request_error',
                    'authentication_error',
                    'rate_limit_error',
                    'api_error',
                  ],
                },
                code: {
                  type: 'string',
                  description:
                    'Machine-readable code; this subset is what the public ' + 'endpoints emit.',
                  enum: [
                    ErrorCode.INVALID_API_KEY,
                    ErrorCode.WRONG_SCOPE,
                    ErrorCode.VALIDATION_ERROR,
                    ErrorCode.RATE_LIMIT_EXCEEDED,
                    ErrorCode.INTERNAL_ERROR,
                    ErrorCode.RESOURCE_NOT_FOUND,
                    ErrorCode.IDEMPOTENCY_CONFLICT,
                    ErrorCode.RESERVATION_STATE_CONFLICT,
                  ],
                },
                message: { type: 'string' },
                param: {
                  type: 'string',
                  description:
                    'Present on validation errors: dot-path of the ' + 'offending field.',
                },
              },
            },
          },
        },
        ...buildBudgetControlSchemas(),
        Provider: {
          type: 'string',
          description: 'LLM provider identifier.',
          enum: Object.values(Provider),
        },
        TelemetryEvent: {
          type: 'object',
          description:
            'One telemetry event (wire schema v1.6). Reports usage, never ' +
            'cost: there is no cost_usd field; the backend prices events.',
          required: [
            'schema_version',
            'run_id',
            'parent_run_id',
            'trace_id',
            'span_id',
            'parent_span_id',
            'customer_id',
            'step_name',
            'model',
            'provider',
            'tokens_in',
            'tokens_out',
            'latency_ms',
            'tool_name',
            'status',
            'framework',
            'instrumentation_tier',
            'cost_source',
            'metric',
            'metric_value',
            'stream_aborted',
            'abort_savings_usd',
            'sdk_version',
            'timestamp',
          ],
          properties: {
            schema_version: {
              type: 'string',
              const: '1.6',
              description: 'Wire schema version; this document describes v1.6.',
            },
            run_id: { type: 'string', format: 'uuid', description: 'UUID v4.' },
            parent_run_id: { type: ['string', 'null'], format: 'uuid' },
            trace_id: { type: 'string', format: 'uuid', description: 'UUID v4.' },
            span_id: {
              type: 'string',
              format: 'uuid',
              description: 'UUID v4, unique per logical event; the ingest idempotency key.',
            },
            parent_span_id: { type: ['string', 'null'], format: 'uuid' },
            customer_id: {
              type: 'string',
              minLength: 1,
              maxLength: 255,
              pattern: CUSTOMER_ID_PATTERN,
              description: 'Builder-assigned end-customer identifier.',
            },
            step_name: {
              type: ['string', 'null'],
              maxLength: 200,
              pattern: STEP_NAME_PATTERN,
            },
            model: {
              type: ['string', 'null'],
              maxLength: 100,
              pattern: MODEL_PATTERN,
              description:
                'Required (non-null) for sdk_wrapper events; must be null ' +
                'for reported events.',
            },
            provider: {
              description: 'Required (non-null) for sdk_wrapper events.',
              anyOf: [schemaRef('Provider'), { type: 'null' }],
            },
            tokens_in: {
              type: 'integer',
              minimum: 0,
              maximum: UINT32_MAX,
              description:
                'Events exceeding the maximum are rejected individually. ' +
                'Must be 0 for reported events.',
            },
            tokens_out: {
              type: 'integer',
              minimum: 0,
              maximum: UINT32_MAX,
              description:
                'Events exceeding the maximum are rejected individually. ' +
                'Must be 0 for reported events.',
            },
            latency_ms: { type: 'integer', minimum: 0 },
            tool_name: {
              type: ['string', 'null'],
              maxLength: 200,
              pattern: STEP_NAME_PATTERN,
            },
            status: {
              type: 'string',
              enum: Object.values(EventStatus),
              description: 'Must be aborted exactly when stream_aborted is true.',
            },
            framework: { type: 'string', enum: Object.values(Framework) },
            instrumentation_tier: {
              type: 'string',
              enum: Object.values(InstrumentationTier),
              description:
                'sdk_wrapper events require model + provider and forbid ' +
                'metric/metric_value; reported events require metric and a ' +
                'metric_value between 0 and 1000000000, forbid model, and ' +
                'require zero token counts.',
            },
            cost_source: { type: 'string', enum: Object.values(CostSource) },
            metric: { type: ['string', 'null'], maxLength: 200 },
            metric_value: { type: ['number', 'null'] },
            stream_aborted: { type: 'boolean' },
            abort_savings_usd: {
              type: 'number',
              minimum: 0,
              maximum: MAX_STORABLE_COST_USD,
            },
            sdk_version: { type: 'string', minLength: 1, maxLength: 50 },
            timestamp: {
              type: 'string',
              format: 'date-time',
              description:
                'ISO 8601. Events stamped more than 15 minutes in the ' +
                'future are rejected per event (clock-skew guard).',
            },
            metadata: {
              description: 'Optional free-form metadata, at most 4 KB serialized.',
              anyOf: [
                {
                  type: 'object',
                  properties: {
                    token_count_source: {
                      type: 'string',
                      enum: Object.values(TokenCountSource),
                    },
                  },
                  additionalProperties: true,
                },
                { type: 'null' },
              ],
            },
          },
        },
        IngestRequest: {
          type: 'object',
          required: ['batch_id', 'sdk_version', 'events'],
          properties: {
            batch_id: {
              type: 'string',
              format: 'uuid',
              description:
                'Client-generated UUID v4 identifying the batch (used for ' + 'log correlation).',
            },
            sdk_version: { type: 'string', minLength: 1, maxLength: 50 },
            events: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: schemaRef('TelemetryEvent'),
            },
          },
        },
        IngestError: {
          type: 'object',
          required: ['index', 'message'],
          properties: {
            index: {
              type: 'integer',
              minimum: 0,
              description: 'Position of the rejected event in events[].',
            },
            message: { type: 'string' },
          },
        },
        IngestWarning: {
          type: 'object',
          required: ['event_index', 'code'],
          properties: {
            event_index: { type: 'integer', minimum: 0 },
            code: {
              type: 'string',
              enum: Object.values(IngestWarningCode),
              description:
                "needs_pricing_input: no price is known for the event's " +
                'provider/model or metric, so it was stored unpriced; ' +
                'pending_pricing: a custom price exists but is not yet ' +
                'effective; customer_limit_reached: telemetry was accepted ' +
                'but one or more newly discovered customers were not added ' +
                'to the dashboard customer list because the tier customer ' +
                'limit was reached.',
            },
            provider: { type: ['string', 'null'] },
            model: { type: ['string', 'null'] },
            metric: { type: ['string', 'null'] },
            message: { type: 'string' },
          },
        },
        BudgetExceededFlag: {
          type: 'object',
          required: [
            'rule_id',
            'customer_id',
            'limit_usd',
            'accumulated_usd',
            'period',
            'period_start',
          ],
          properties: {
            rule_id: { type: 'string', format: 'uuid' },
            customer_id: {
              type: ['string', 'null'],
              description: 'null for pooled-scope budgets.',
            },
            limit_usd: { type: 'number' },
            accumulated_usd: { type: 'number' },
            period: { type: 'string', enum: Object.values(RulePeriod) },
            period_start: { type: 'string', format: 'date-time' },
          },
        },
        IngestResponse: {
          type: 'object',
          required: ['accepted', 'rejected'],
          properties: {
            accepted: {
              type: 'integer',
              minimum: 0,
              description:
                'Events persisted from this batch. Deduplicated replays ' +
                'are dropped silently and counted in neither accepted nor ' +
                'rejected.',
            },
            rejected: {
              type: 'integer',
              minimum: 0,
              description: 'Events rejected by per-event semantic validation.',
            },
            errors: {
              type: 'array',
              items: schemaRef('IngestError'),
              description: 'Present only when rejected > 0.',
            },
            warnings: {
              type: 'array',
              items: schemaRef('IngestWarning'),
              description:
                'Pricing-coverage warnings for accepted events; present ' + 'only when non-empty.',
            },
            budget_exceeded: {
              type: 'array',
              items: schemaRef('BudgetExceededFlag'),
              description:
                'Authoritative pre-call flags; present only when ' +
                'non-empty. A non-empty array means the SDK should bump ' +
                'its local accumulators so the next pre-call check for ' +
                'each listed key blocks.',
            },
          },
        },
        Rule: {
          type: 'object',
          description:
            'A reactive rule row. The SDK sync only ever returns active, ' +
            'enabled, pre_call rules.',
          required: [
            'id',
            'builder_id',
            'type',
            'enforcement',
            'name',
            'enabled',
            'config',
            'customer_id',
            'status',
            'activated_at',
            'last_triggered_at',
            'last_error',
            'created_at',
            'updated_at',
          ],
          properties: {
            id: { type: 'string', format: 'uuid' },
            builder_id: { type: 'string', format: 'uuid' },
            type: { type: 'string', enum: Object.values(RuleType) },
            enforcement: {
              type: 'string',
              enum: Object.values(RuleEnforcement),
            },
            name: { type: 'string' },
            enabled: { type: 'boolean' },
            config: {
              type: 'object',
              additionalProperties: true,
              description:
                'Type-specific configuration, discriminated by type (for ' +
                'example budget_limit carries limit_usd, period, ' +
                'hard_stop, and scope).',
            },
            customer_id: {
              type: ['string', 'null'],
              description:
                'null applies the rule to all customers; config.scope ' +
                'disambiguates per-customer vs pooled budgets.',
            },
            status: { type: 'string', enum: Object.values(RuleStatus) },
            activated_at: { type: ['string', 'null'], format: 'date-time' },
            last_triggered_at: { type: ['string', 'null'], format: 'date-time' },
            last_error: { type: ['string', 'null'] },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        RulesResponse: {
          type: 'object',
          required: ['rules', 'ttl_seconds', 'fetched_at'],
          properties: {
            rules: { type: 'array', items: schemaRef('Rule') },
            ttl_seconds: {
              type: 'integer',
              const: 60,
              description:
                'Cache lifetime. Constant 60 so newly activated rules ' +
                'reach SDKs within a minute.',
            },
            fetched_at: { type: 'string', format: 'date-time' },
          },
        },
        PricingModel: {
          type: 'object',
          required: [
            'id',
            'provider',
            'model',
            'input_per_1m',
            'output_per_1m',
            'effective_from',
            'effective_to',
            'source',
            'created_at',
          ],
          properties: {
            id: { type: 'integer' },
            provider: { type: 'string' },
            model: { type: 'string' },
            input_per_1m: {
              type: 'number',
              description: 'USD per one million input tokens.',
            },
            output_per_1m: {
              type: 'number',
              description: 'USD per one million output tokens.',
            },
            effective_from: { type: 'string', format: 'date-time' },
            effective_to: {
              type: ['string', 'null'],
              format: 'date-time',
              description: 'null while the price is open-ended.',
            },
            source: { type: 'string', enum: ['auto', 'admin'] },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        PricingResponse: {
          type: 'object',
          required: ['models', 'updated_at'],
          properties: {
            models: { type: 'array', items: schemaRef('PricingModel') },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        BudgetSyncEntry: {
          type: 'object',
          required: [
            'rule_id',
            'scope',
            'customer_id',
            'accumulated_cost_usd',
            'period_start',
            'event_count',
          ],
          properties: {
            rule_id: { type: 'string', format: 'uuid' },
            scope: { type: 'string', enum: Object.values(RuleScope) },
            customer_id: {
              type: ['string', 'null'],
              description: 'null exactly when scope is pooled.',
            },
            accumulated_cost_usd: { type: 'number', minimum: 0 },
            period_start: {
              type: 'string',
              format: 'date-time',
              description: 'ISO 8601 start of the budget period bucket.',
            },
            event_count: { type: 'integer', minimum: 0 },
          },
        },
        BudgetSyncRequest: {
          type: 'object',
          required: ['entries'],
          properties: {
            entries: {
              type: 'array',
              maxItems: 500,
              items: schemaRef('BudgetSyncEntry'),
            },
          },
        },
        BudgetSyncResult: {
          type: 'object',
          required: [
            'rule_id',
            'scope',
            'customer_id',
            'period_start',
            'server_total_usd',
            'budget_remaining_usd',
            'budget_exceeded',
            'reconciled_at',
          ],
          properties: {
            rule_id: { type: 'string', format: 'uuid' },
            scope: { type: 'string', enum: Object.values(RuleScope) },
            customer_id: { type: ['string', 'null'] },
            period_start: {
              type: 'string',
              format: 'date-time',
              description: 'Echoes the request key.',
            },
            server_total_usd: {
              type: 'number',
              description:
                "Authoritative spend for the period; replaces the SDK's " + 'local accumulator.',
            },
            budget_remaining_usd: { type: ['number', 'null'] },
            budget_exceeded: { type: 'boolean' },
            reconciled_at: { type: 'string', format: 'date-time' },
          },
        },
        BudgetSyncResponse: {
          type: 'object',
          required: ['entries'],
          properties: {
            entries: { type: 'array', items: schemaRef('BudgetSyncResult') },
          },
        },
        WhoamiResponse: {
          type: 'object',
          description:
            'Identity and plan information for the presented Agent SDK ' +
            'key. usage is null when event limits are not enforced ' +
            '(self-hosted default), on unlimited plans, or if the usage ' +
            'lookup fails open; limits.enforced distinguishes those cases.',
          required: ['org', 'tier', 'key', 'limits', 'usage', 'docs_url', 'agent_setup_url'],
          properties: {
            org: {
              type: 'object',
              required: ['slug', 'name'],
              properties: {
                slug: { type: 'string', description: 'Workspace slug.' },
                name: { type: 'string', description: 'Workspace display name.' },
              },
            },
            tier: { type: 'string', enum: Object.values(BuilderTier) },
            key: {
              type: 'object',
              required: ['id', 'scope'],
              properties: {
                id: {
                  type: 'string',
                  description: 'Public key identifier — never the secret.',
                },
                scope: { type: 'string', const: 'agent_sdk' },
              },
            },
            limits: {
              type: 'object',
              required: ['monthly_events', 'enforced'],
              properties: {
                monthly_events: {
                  type: ['integer', 'null'],
                  description: 'Plan cap on monthly events; null means unlimited.',
                },
                enforced: { type: 'boolean' },
              },
            },
            usage: {
              type: ['object', 'null'],
              required: [
                'monthly_events_used',
                'monthly_events_limit',
                'window_start',
                'window_end',
                'window_source',
              ],
              properties: {
                monthly_events_used: { type: 'integer' },
                monthly_events_limit: { type: 'integer' },
                window_start: { type: 'string', format: 'date-time' },
                window_end: { type: 'string', format: 'date-time' },
                window_source: {
                  type: 'string',
                  enum: Object.values(EventCapWindowSource),
                },
              },
            },
            docs_url: { type: 'string', format: 'uri' },
            agent_setup_url: {
              type: 'string',
              format: 'uri',
              description: 'Machine-readable setup runbook for coding agents.',
            },
          },
        },
      },
    },
  };
}
