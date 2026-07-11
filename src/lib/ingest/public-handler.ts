import * as v from 'valibot';
import {
  ErrorCode,
  IngestRequestSchema,
  IngestWarningCode,
  InstrumentationTier,
  Provider,
  RETENTION_FALLBACK_DAYS,
  TIER_LIMITS,
  billingRetentionDays,
  telemetryRetentionDays,
  type BuilderTier,
  type IngestResponse,
  type TelemetryEvent,
  type RulePeriod,
  type CostUpdateMessage,
} from '@pylva/shared';
import { logger } from '../logger.js';
import { validateSemantic } from './semantic-validation.js';
import { lookupPricing } from './pricing-lookup.js';
import { filterDuplicates, undoFilterDuplicates } from './dedup.js';
import { ensureOnboardingTask } from './onboarding.js';
import { calculateCostUsd } from '../cost-calculator.js';
import { insertCostEventsWithRetry, type CostEventRow } from '../clickhouse/events.js';
import { extractExternalCustomerId, toCompositeCustomerId } from '../clickhouse/customer-id.js';
import { withRLS } from '../db/rls.js';
import { customers } from '../db/schema.js';
import {
  checkEventCap,
  formatTierUsage,
  getCapContext,
  recordAcceptedEvents,
  type EventCapDecision,
} from './event-cap.js';
import { evaluatePostCall } from '../rules/post-call-evaluator.js';
import { listActiveRulesForCustomer } from '../rules/repository.js';
import { periodStartFor } from '../budget/period-utils.js';
import { aggregateSpendForRule } from '../budget/aggregate.js';
import { recordSourceSighting } from './last-seen-buffer.js';
import { publishFeedMessage } from '../realtime/feed-publisher.js';
import { getBuilderTierForShare, lockCustomerLimit } from '../db/advisory-locks.js';
import {
  forbiddenErrorResponse,
  internalErrorResponse,
  jsonResponse,
  validationErrorResponse,
  type PublicHttpResponse,
} from '../public-http/response.js';
import { and, count, eq, inArray } from 'drizzle-orm';

export interface IngestHandlerInput {
  builderId: string;
  keyId: string;
  rawBody: string;
}

function operationFromEvent(event: TelemetryEvent): string {
  if (event.instrumentation_tier === InstrumentationTier.REPORTED) return 'reported';
  if (event.tool_name) return 'tool_call';
  return 'chat.completions';
}

function onboardingMemoKey(event: TelemetryEvent): string {
  if (event.instrumentation_tier === InstrumentationTier.REPORTED && event.metric) {
    return `metric:${event.metric}`;
  }
  return `llm:${event.provider ?? ''}:${event.model ?? ''}`;
}

function retentionStampForTier(tier: BuilderTier | null): {
  retention_days: number;
  billing_retention_days: number;
} {
  if (!tier) {
    return {
      retention_days: RETENTION_FALLBACK_DAYS,
      billing_retention_days: RETENTION_FALLBACK_DAYS,
    };
  }
  return {
    retention_days: telemetryRetentionDays(tier),
    billing_retention_days: billingRetentionDays(tier),
  };
}

function firstValibotIssue(
  issues: ReadonlyArray<{ message: string; path?: ReadonlyArray<{ key: unknown }> }>,
): { message: string; param: string } {
  const first = issues[0];
  if (!first) return { message: 'Invalid request body', param: 'body' };
  const param = (first.path ?? [])
    .map((item) =>
      typeof item.key === 'string' || typeof item.key === 'number' ? String(item.key) : '',
    )
    .filter((item) => item.length > 0)
    .join('.');
  return { message: first.message, param: param || 'body' };
}

interface DiscoveredCustomerRef {
  externalId: string;
  eventIndex: number;
}

interface CustomerDiscoveryResult {
  skipped: DiscoveredCustomerRef[];
  current: number | null;
  limit: number;
  deferred: number;
  tier: BuilderTier | null;
}

function distinctDiscoveredCustomerRefs(refs: DiscoveredCustomerRef[]): DiscoveredCustomerRef[] {
  const seen = new Set<string>();
  const result: DiscoveredCustomerRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.externalId)) continue;
    seen.add(ref.externalId);
    result.push(ref);
  }
  return result;
}

async function ensureDiscoveredCustomers(
  builderId: string,
  refs: DiscoveredCustomerRef[],
): Promise<CustomerDiscoveryResult> {
  // The authoritative tier is read inside the locked transaction below; callers
  // never pass one (a pre-transaction read would be stale for enforcement).
  if (refs.length === 0) {
    return { skipped: [], current: null, limit: Infinity, deferred: 0, tier: null };
  }

  const distinctRefs = distinctDiscoveredCustomerRefs(refs);

  return withRLS(builderId, async (tx) => {
    await lockCustomerLimit(tx, builderId);
    const freshTier = await getBuilderTierForShare(tx, builderId);
    if (freshTier === null) {
      return {
        skipped: [],
        current: null,
        limit: Infinity,
        deferred: distinctRefs.length,
        tier: null,
      };
    }

    const limit = TIER_LIMITS[freshTier].max_customers;
    if (!Number.isFinite(limit)) {
      await tx
        .insert(customers)
        .values(
          distinctRefs.map((ref) => ({
            builder_id: builderId,
            external_id: ref.externalId,
          })),
        )
        .onConflictDoNothing({ target: [customers.builder_id, customers.external_id] });
      return { skipped: [], current: null, limit, deferred: 0, tier: freshTier };
    }

    const externalIds = distinctRefs.map((ref) => ref.externalId);
    const [countRow] = await tx
      .select({ count: count() })
      .from(customers)
      .where(eq(customers.builder_id, builderId));
    const current = countRow?.count ?? 0;
    const existingRows = await tx
      .select({ external_id: customers.external_id })
      .from(customers)
      .where(and(eq(customers.builder_id, builderId), inArray(customers.external_id, externalIds)));
    const existing = new Set(existingRows.map((row) => row.external_id));
    const newRefs = distinctRefs.filter((ref) => !existing.has(ref.externalId));
    const allowedCount = Math.max(0, Math.min(newRefs.length, limit - current));
    const allowedRefs = newRefs.slice(0, allowedCount);
    const skipped = newRefs.slice(allowedCount);

    if (allowedRefs.length > 0) {
      await tx
        .insert(customers)
        .values(
          allowedRefs.map((ref) => ({
            builder_id: builderId,
            external_id: ref.externalId,
          })),
        )
        .onConflictDoNothing({ target: [customers.builder_id, customers.external_id] });
    }

    return { skipped, current: current + allowedRefs.length, limit, deferred: 0, tier: freshTier };
  });
}

function usageHeaderForDecision(
  decision: EventCapDecision,
  persistedUsed?: number | null,
): Record<string, string> {
  if (decision.used === null || !Number.isFinite(decision.cap)) return {};
  const used = persistedUsed === undefined ? decision.used : persistedUsed;
  if (used === null) return {};
  return {
    'X-Pylva-Tier-Usage': formatTierUsage(used, decision.cap),
  };
}

function blockedCapMessage(decision: EventCapDecision): string {
  const tier = decision.tier ?? 'current';
  const cap = decision.cap;
  const used = decision.used ?? cap;
  const windowEnd = decision.window?.end ?? new Date();
  return `${tier} tier is configured for ${cap} events per period. You have used ${used}. Ingestion is paused until ${windowEnd.toISOString()}. Ask the self-host operator to raise the event cap or disable ENABLE_EVENT_LIMITS.`;
}

async function tierForRetention(
  builderId: string,
  capDecision: EventCapDecision,
): Promise<BuilderTier | null> {
  if (capDecision.enabled) return capDecision.tier;

  const context = await getCapContext(builderId);
  return context.tier;
}

export async function handleTelemetryIngest(
  input: IngestHandlerInput,
): Promise<PublicHttpResponse> {
  const { builderId, keyId, rawBody } = input;
  const log = logger.child({
    module: 'ingest',
    builder_id: builderId,
    key_id: keyId,
  });

  const capDecision = await checkEventCap(builderId);
  if (capDecision.blocked) {
    const response = forbiddenErrorResponse(
      ErrorCode.TIER_LIMIT_REACHED,
      blockedCapMessage(capDecision),
    );
    response.headers = { ...response.headers, ...usageHeaderForDecision(capDecision) };
    return response;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody);
  } catch {
    return validationErrorResponse('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(IngestRequestSchema, parsedJson);
  if (!parsed.success) {
    const { message, param } = firstValibotIssue(parsed.issues);
    return validationErrorResponse(message, param);
  }
  const { batch_id, events } = parsed.output;

  const errors: NonNullable<IngestResponse['errors']> = [];
  const warnings: NonNullable<IngestResponse['warnings']> = [];
  const seenSpanIds = new Set<string>();
  const semanticallyOk: Array<{ index: number; event: TelemetryEvent }> = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    const semantic = validateSemantic(event);
    if (!semantic.ok) {
      errors.push({ index: i, message: semantic.error });
      continue;
    }
    if (seenSpanIds.has(event.span_id)) continue;
    seenSpanIds.add(event.span_id);
    semanticallyOk.push({ index: i, event });
  }

  if (semanticallyOk.length === 0) {
    const resp: IngestResponse = {
      accepted: 0,
      rejected: errors.length,
      ...(errors.length > 0 ? { errors } : {}),
    };
    log.info(
      { accepted: 0, rejected: resp.rejected, batch_id },
      'ingest completed (no events survived validation)',
    );
    return jsonResponse(resp, 200, usageHeaderForDecision(capDecision));
  }

  const survivingEvents = semanticallyOk.map((x) => x.event);
  let resolvedTier: BuilderTier | null;
  try {
    resolvedTier = await tierForRetention(builderId, capDecision);
  } catch (err) {
    log.warn(
      { batch_id, error: err instanceof Error ? err.message : String(err) },
      'event cap context threw; using fallback retention',
    );
    resolvedTier = null;
  }
  const retentionStamp = retentionStampForTier(resolvedTier);
  const [pricingMap, keptSpanIds] = await Promise.all([
    lookupPricing(builderId, survivingEvents),
    filterDuplicates(
      builderId,
      survivingEvents.map((event) => ({
        span_id: event.span_id,
        timestamp: event.timestamp,
      })),
    ),
  ]);

  const rows: CostEventRow[] = [];
  const feedMessages: CostUpdateMessage['data'][] = [];
  const onboardingNeeded = new Map<string, TelemetryEvent>();
  const discoveredCustomerRefs: DiscoveredCustomerRef[] = [];

  for (const { index, event } of semanticallyOk) {
    if (!keptSpanIds.has(event.span_id)) continue;
    const cost = calculateCostUsd(event, pricingMap);

    if (cost.pricing_status === 'needs_input') {
      warnings.push({
        event_index: index,
        code: IngestWarningCode.NEEDS_PRICING_INPUT,
        provider: event.provider,
        model: event.model,
        metric: event.metric,
      });
      onboardingNeeded.set(onboardingMemoKey(event), event);
    }

    discoveredCustomerRefs.push({ externalId: event.customer_id, eventIndex: index });

    feedMessages.push({
      customer_id: event.customer_id,
      cost_usd: cost.cost_usd ?? 0,
      model: event.model,
      provider: event.provider ?? null,
      step_name: event.step_name,
      timestamp: event.timestamp,
    });

    rows.push({
      timestamp: event.timestamp,
      builder_id: builderId,
      trace_id: event.trace_id,
      span_id: event.span_id,
      parent_span_id: event.parent_span_id,
      customer_id: toCompositeCustomerId(builderId, event.customer_id),
      provider: event.provider ?? Provider.OTHER,
      model: event.model,
      operation: operationFromEvent(event),
      step_name: event.step_name,
      tokens_in: event.tokens_in,
      tokens_out: event.tokens_out,
      cost_usd: cost.cost_usd,
      pricing_status: cost.pricing_status,
      latency_ms: event.latency_ms,
      status: event.status,
      cost_source: event.cost_source,
      instrumentation_tier: event.instrumentation_tier,
      metric: event.metric,
      metric_value: event.metric_value,
      stream_aborted: event.stream_aborted ? 1 : 0,
      abort_savings: event.abort_savings_usd,
      retention_days: retentionStamp.retention_days,
      billing_retention_days: retentionStamp.billing_retention_days,
      metadata: JSON.stringify({
        sdk_version: event.sdk_version,
        framework: event.framework,
        token_count_source: event.metadata?.token_count_source,
        tool_name: event.tool_name,
        run_id: event.run_id,
        parent_run_id: event.parent_run_id,
      }),
    });
  }

  try {
    if (rows.length > 0) await insertCostEventsWithRetry(rows);
  } catch (err) {
    const keptItems = rows.map((row) => ({
      span_id: row.span_id,
      timestamp: row.timestamp,
    }));
    await undoFilterDuplicates(builderId, keptItems);
    log.error(
      { batch_id, error: err instanceof Error ? err.message : String(err) },
      'ingest persistence failed',
    );
    return internalErrorResponse('failed to persist events');
  }

  let persistedEventCapUsed: number | null | undefined;
  if (rows.length > 0) {
    persistedEventCapUsed = await recordAcceptedEvents(builderId, capDecision, rows.length);
  }

  if (rows.length > 0) {
    const distinctProviders = new Set(
      rows
        .filter((row) => row.instrumentation_tier === InstrumentationTier.SDK_WRAPPER)
        .map((row) => row.provider)
        .filter((provider): provider is string => !!provider),
    );
    for (const provider of distinctProviders) {
      void recordSourceSighting(builderId, provider).catch(() => {});
    }
    try {
      const discovery = await ensureDiscoveredCustomers(builderId, discoveredCustomerRefs);
      if (discovery.deferred > 0) {
        log.warn(
          {
            event: 'customer_discovery_deferred_unknown_tier',
            builder_id: builderId,
            deferred_count: discovery.deferred,
            batch_id,
          },
          'customer auto-registration deferred because builder tier is unknown',
        );
      } else if (discovery.skipped.length > 0) {
        const firstSkipped = discovery.skipped[0]!;
        const discoveryTier = discovery.tier ?? 'current';
        const message = `${discoveryTier} tier allows ${discovery.limit} customers. ${discovery.skipped.length} telemetry customer${discovery.skipped.length === 1 ? '' : 's'} were not added to the dashboard customer list; events were accepted. Upgrade to track more discovered customers.`;
        warnings.push({
          event_index: firstSkipped.eventIndex,
          code: IngestWarningCode.CUSTOMER_LIMIT_REACHED,
          message,
        });
        log.warn(
          {
            event: 'customer_limit_reached',
            tier: discovery.tier,
            current: discovery.current,
            limit: discovery.limit,
            skipped_count: discovery.skipped.length,
            batch_id,
          },
          'customer auto-registration skipped at tier customer limit',
        );
      }
    } catch (err) {
      log.warn(
        {
          batch_id,
          failed_count: distinctDiscoveredCustomerRefs(discoveredCustomerRefs).length,
          error: err instanceof Error ? err.message : String(err),
        },
        'customer auto-registration failed after ingest persistence',
      );
    }
    for (const data of feedMessages) {
      void publishFeedMessage(builderId, { type: 'cost_update', data });
    }
  }

  if (onboardingNeeded.size > 0) {
    void withRLS(builderId, async (tx) => {
      for (const event of onboardingNeeded.values()) {
        await ensureOnboardingTask(tx, builderId, {
          provider: event.provider,
          model: event.model,
          metric: event.metric,
        });
      }
    }).catch((err) => {
      log.warn(
        { batch_id, error: err instanceof Error ? err.message : String(err) },
        'onboarding task creation failed after ingest persistence',
      );
    });
  }

  const budgetExceeded = rows.length > 0 ? await computeBudgetExceededFlags(builderId, rows) : [];

  const resp: IngestResponse = {
    accepted: rows.length,
    rejected: errors.length,
    ...(errors.length > 0 ? { errors } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(budgetExceeded.length > 0 ? { budget_exceeded: budgetExceeded } : {}),
  };
  log.info(
    {
      accepted: resp.accepted,
      rejected: resp.rejected,
      budget_hits: budgetExceeded.length,
      batch_id,
    },
    'ingest completed',
  );

  if (rows.length > 0) {
    void evaluatePostCall(
      builderId,
      rows.map((row) => ({
        customer_id: row.customer_id,
        cost_usd: row.cost_usd,
        timestamp: row.timestamp,
      })),
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ error: message }, 'post-call evaluator threw');
    });
  }

  return jsonResponse(resp, 200, usageHeaderForDecision(capDecision, persistedEventCapUsed));
}

type BudgetExceededFlag = NonNullable<IngestResponse['budget_exceeded']>[number];

async function computeBudgetExceededFlags(
  builderId: string,
  rows: CostEventRow[],
): Promise<BudgetExceededFlag[]> {
  const distinctCustomers = Array.from(new Set(rows.map((row) => row.customer_id)));
  const flags: BudgetExceededFlag[] = [];
  for (const compositeCustomerId of distinctCustomers) {
    const externalCustomerId = extractExternalCustomerId(compositeCustomerId, builderId);
    const rules = await listActiveRulesForCustomer(builderId, externalCustomerId);
    for (const rule of rules) {
      if (rule.type !== 'budget_limit') continue;
      const cfg = rule.config as {
        limit_usd: number;
        period: RulePeriod;
        scope: 'per_customer' | 'pooled';
      };
      const scopedCompositeCustomerId = cfg.scope === 'pooled' ? null : compositeCustomerId;
      const scopedExternalCustomerId = cfg.scope === 'pooled' ? null : externalCustomerId;
      const total = await aggregateSpendForRule(builderId, rule, scopedCompositeCustomerId);
      if (total >= cfg.limit_usd) {
        flags.push({
          rule_id: rule.id,
          customer_id: scopedExternalCustomerId,
          limit_usd: cfg.limit_usd,
          accumulated_usd: total,
          period: cfg.period,
          period_start: periodStartFor(cfg.period).toISOString(),
        });
      }
    }
  }
  return flags;
}
