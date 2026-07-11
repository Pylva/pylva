// B2a T3 — rules data access. All writes/reads go through withRLS so foreign
// builders get 0 rows. Used by both the dashboard CRUD routes and the
// post-call evaluator.

import { and, eq, ne, desc, exists, sql as drizzleSql } from 'drizzle-orm';
import { rules, ruleAlertChannels, webhookConfigs } from '../db/schema.js';
import { withRLS, type DrizzleTransaction } from '../db/rls.js';
import { LIVE_TRAFFIC_RULE_TYPES } from './categories.js';
import { logger } from '../logger.js';
import {
  RuleEnforcement,
  RuleStatus,
  type AlertChannelEntry,
  type Rule,
  type RuleEnforcement as RuleEnforcementType,
  type RuleType as RuleTypeType,
  type RuleStatus as RuleStatusType,
} from '@pylva/shared';

const log = logger.child({ module: 'rules.repository' });

export interface CreateRuleInput {
  builder_id: string;
  type: RuleTypeType;
  name: string;
  enforcement?: RuleEnforcementType;
  enabled?: boolean;
  customer_id?: string | null;
  config: Record<string, unknown>;
  status?: RuleStatusType;
}

export interface ListRulesOptions {
  excludeDrafts?: boolean;
  excludeDisabled?: boolean;
  enforcement?: RuleEnforcementType;
}

export async function listRules(builderId: string, opts?: ListRulesOptions): Promise<Rule[]> {
  const conditions = [eq(rules.builder_id, builderId)];
  if (opts?.excludeDrafts) {
    conditions.push(ne(rules.status, RuleStatus.DRAFT));
  }
  if (opts?.excludeDisabled) {
    conditions.push(eq(rules.enabled, true));
  }
  if (opts?.enforcement) {
    conditions.push(eq(rules.enforcement, opts.enforcement));
  }
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select()
      .from(rules)
      .where(and(...conditions))
      .orderBy(desc(rules.created_at)),
  );
  return rows.map(mapRow);
}

export async function getRule(builderId: string, ruleId: string): Promise<Rule | null> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select()
      .from(rules)
      .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId)))
      .limit(1),
  );
  if (rows.length === 0) return null;
  return mapRow(rows[0]!);
}

export async function listActiveRulesForCustomer(
  builderId: string,
  customerId: string | null,
): Promise<Rule[]> {
  // Active = enabled. Rule targeting:
  //   rule.customer_id === null → applies to all customers (scope disambig)
  //   rule.customer_id === customerId → that customer only
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .select()
      .from(rules)
      .where(
        and(
          eq(rules.builder_id, builderId),
          eq(rules.enabled, true),
          eq(rules.status, RuleStatus.ACTIVE),
        ),
      ),
  );
  return rows.filter((r) => r.customer_id === null || r.customer_id === customerId).map(mapRow);
}

export async function createRule(input: CreateRuleInput): Promise<Rule> {
  // Default by category, not just budget_limit: the SDK rules fetch filters
  // enforcement=pre_call, so a model_routing/reliability_failover draft
  // that defaulted to post_call would activate into a rule the SDK never
  // sees — dead routing the builder believes is live.
  const enforcement =
    input.enforcement ??
    (LIVE_TRAFFIC_RULE_TYPES.has(input.type) ? RuleEnforcement.PRE_CALL : RuleEnforcement.POST_CALL);
  const inserted = await withRLS(input.builder_id, async (tx) => {
    const rows = await tx
      .insert(rules)
      .values({
        builder_id: input.builder_id,
        type: input.type,
        enforcement,
        name: input.name,
        enabled: input.enabled ?? true,
        config: input.config,
        customer_id: input.customer_id ?? null,
        status: input.status ?? RuleStatus.ACTIVE,
      })
      .returning();
    return rows[0]!;
  });
  log.info(
    { builder_id: input.builder_id, rule_id: inserted.id, type: inserted.type },
    'rule created',
  );
  return mapRow(inserted);
}

export async function updateRule(
  builderId: string,
  ruleId: string,
  // `enforcement` is repository-internal (activation's legacy-draft heal);
  // the PATCH route's body schema never exposes it.
  patch: Partial<Pick<CreateRuleInput, 'name' | 'enabled' | 'customer_id' | 'config' | 'enforcement'>>,
): Promise<Rule | null> {
  const updated = await withRLS(builderId, async (tx) => {
    const setClause: Record<string, unknown> = { updated_at: new Date() };
    if (patch.name !== undefined) setClause['name'] = patch.name;
    if (patch.enabled !== undefined) setClause['enabled'] = patch.enabled;
    if (patch.customer_id !== undefined) setClause['customer_id'] = patch.customer_id;
    if (patch.config !== undefined) setClause['config'] = patch.config;
    if (patch.enforcement !== undefined) setClause['enforcement'] = patch.enforcement;
    const rows = await tx
      .update(rules)
      .set(setClause)
      .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId)))
      .returning();
    return rows[0] ?? null;
  });
  return updated ? mapRow(updated) : null;
}

export async function deleteRule(builderId: string, ruleId: string): Promise<boolean> {
  const rowsAffected = await withRLS(builderId, async (tx) => {
    const rows = await tx
      .delete(rules)
      .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId)))
      .returning({ id: rules.id });
    return rows.length;
  });
  return rowsAffected > 0;
}

export async function toggleRule(
  builderId: string,
  ruleId: string,
  enabled: boolean,
): Promise<Rule | null> {
  return updateRule(builderId, ruleId, { enabled });
}

// B4-1: status promotion ('draft' → 'active' or 'active' → 'draft'). When
// activating, also stamps activated_at + clears any prior last_error.
// Demotion to 'draft' is the safe rollback path — the SDK rules cache
// drops the rule on next 5-min refresh.
export async function promoteRuleStatus(
  builderId: string,
  ruleId: string,
  nextStatus: (typeof RuleStatus)[keyof typeof RuleStatus],
): Promise<Rule | null> {
  const updated = await withRLS(builderId, async (tx) => {
    const setClause: Record<string, unknown> = {
      status: nextStatus,
      updated_at: new Date(),
    };
    if (nextStatus === RuleStatus.ACTIVE) {
      setClause['activated_at'] = new Date();
      setClause['last_error'] = null;
    }
    const rows = await tx
      .update(rules)
      .set(setClause)
      .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId)))
      .returning();
    return rows[0] ?? null;
  });
  if (updated) {
    log.info(
      { builder_id: builderId, rule_id: ruleId, status: nextStatus },
      'rule status promoted',
    );
  }
  return updated ? mapRow(updated) : null;
}

// B4-4c: stamp last_triggered_at when a rule actually fires (post-call
// alert or margin evaluation) so the dashboard's "last triggered" column
// is truthful. Freshness signal, not an event log — alert_history holds
// the per-fire records.
export async function markRuleTriggered(builderId: string, ruleId: string): Promise<void> {
  await withRLS(builderId, async (tx) => {
    await tx
      .update(rules)
      .set({ last_triggered_at: new Date() })
      .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId)));
  });
}

// --- rule_alert_channels ---

export interface ChannelInput {
  rule_id: string;
  channel: 'webhook' | 'email' | 'slack';
  enabled?: boolean;
  webhook_config_id?: string | null;
  email_recipients?: string[] | null;
  slack_webhook_url?: string | null;
}

function ruleOwnedByBuilder(tx: DrizzleTransaction, builderId: string, ruleId: string) {
  return exists(
    tx
      .select({ one: drizzleSql`1` })
      .from(rules)
      .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId))),
  );
}

async function hasRuleForBuilder(
  tx: DrizzleTransaction,
  builderId: string,
  ruleId: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: rules.id })
    .from(rules)
    .where(and(eq(rules.id, ruleId), eq(rules.builder_id, builderId)))
    .limit(1);
  return rows.length > 0;
}

async function hasWebhookConfigForBuilder(
  tx: DrizzleTransaction,
  builderId: string,
  webhookConfigId: string | null | undefined,
): Promise<boolean> {
  if (!webhookConfigId) return false;
  const rows = await tx
    .select({ id: webhookConfigs.id })
    .from(webhookConfigs)
    .where(and(eq(webhookConfigs.id, webhookConfigId), eq(webhookConfigs.builder_id, builderId)))
    .limit(1);
  return rows.length > 0;
}

export async function listChannelsForRule(builderId: string, ruleId: string) {
  return withRLS(builderId, async (tx) =>
    tx
      .select()
      .from(ruleAlertChannels)
      .where(and(eq(ruleAlertChannels.rule_id, ruleId), ruleOwnedByBuilder(tx, builderId, ruleId))),
  );
}

/**
 * listChannelsForRule mapped into the shared AlertChannelEntry shape
 * deliverAlert consumes. One mapping site — the post-call evaluator and
 * the margin evaluator both dispatch through it, so the per-channel
 * config-key spread can't drift between them.
 */
export async function listAlertChannelEntriesForRule(
  builderId: string,
  ruleId: string,
): Promise<AlertChannelEntry[]> {
  const raw = await listChannelsForRule(builderId, ruleId);
  return raw.map((r) => ({
    id: r.id,
    rule_id: r.rule_id,
    channel: r.channel as AlertChannelEntry['channel'],
    enabled: r.enabled,
    ...(r.channel === 'webhook' ? { webhook_config_id: r.webhook_config_id! } : {}),
    ...(r.channel === 'email' ? { email_recipients: r.email_recipients! } : {}),
    ...(r.channel === 'slack' ? { slack_webhook_url: r.slack_webhook_url! } : {}),
    created_at: r.created_at,
    updated_at: r.updated_at,
  })) as AlertChannelEntry[];
}

export async function addChannel(
  builderId: string,
  input: ChannelInput,
): Promise<typeof ruleAlertChannels.$inferSelect | null> {
  return withRLS(builderId, async (tx) => {
    const ownsRule = await hasRuleForBuilder(tx, builderId, input.rule_id);
    if (!ownsRule) return null;
    if (
      input.channel === 'webhook' &&
      !(await hasWebhookConfigForBuilder(tx, builderId, input.webhook_config_id))
    ) {
      return null;
    }

    const rows = await tx
      .insert(ruleAlertChannels)
      .values({
        rule_id: input.rule_id,
        channel: input.channel,
        enabled: input.enabled ?? true,
        webhook_config_id: input.webhook_config_id ?? null,
        email_recipients: input.email_recipients ?? null,
        slack_webhook_url: input.slack_webhook_url ?? null,
      })
      .returning();
    return rows[0] ?? null;
  });
}

export async function removeChannel(
  builderId: string,
  ruleId: string,
  channelId: string,
): Promise<boolean> {
  const rows = await withRLS(builderId, async (tx) =>
    tx
      .delete(ruleAlertChannels)
      .where(
        and(
          eq(ruleAlertChannels.id, channelId),
          eq(ruleAlertChannels.rule_id, ruleId),
          ruleOwnedByBuilder(tx, builderId, ruleId),
        ),
      )
      .returning({ id: ruleAlertChannels.id }),
  );
  return rows.length > 0;
}

function mapRow(r: typeof rules.$inferSelect): Rule {
  return {
    id: r.id,
    builder_id: r.builder_id,
    type: r.type as RuleTypeType,
    enforcement: r.enforcement as RuleEnforcementType,
    name: r.name,
    enabled: r.enabled,
    config: (r.config as Record<string, unknown>) ?? {},
    customer_id: r.customer_id,
    // B3-T3 status column (migration 026). Drizzle typing loses the narrowing
    // so we pass through the DB value and cast to the shared const type.
    status: r.status as Rule['status'],
    activated_at: r.activated_at,
    last_triggered_at: r.last_triggered_at,
    last_error: r.last_error,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
