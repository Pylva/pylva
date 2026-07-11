// Track 1 PR 1.1 — rule detail dashboard.
//
// Reads rule + channels + builder webhook configs (for the channel
// dropdown), renders rule meta, channel CRUD UI, and status/disabled
// banners. Owner-only mutations enforced both in the route handlers
// and in the UI; members get a read-only banner per O18.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation.js';
import { eq } from 'drizzle-orm';
import { Role, RuleStatus, type Rule } from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { getRule, listChannelsForRule } from '@/lib/rules/repository';
import { withRLS } from '@/lib/db/rls';
import { webhookConfigs } from '@/lib/db/schema';
import { COPY } from '@/lib/copy';
import { RuleToggle } from '@/components/rules/RuleToggle';
import { RuleActivateButton } from '@/components/rules/RuleActivateButton';
import {
  RuleChannelsManager,
  type ChannelRow,
  type WebhookOption,
} from '@/components/rules/RuleChannelsManager';

export const metadata: Metadata = { title: 'Rule' };

export default async function RuleDetailPage({
  params,
}: {
  params: Promise<{ slug: string; id: string }>;
}) {
  const { builderId, role } = await readDashboardHeaders();
  const { slug, id } = await params;

  const rule = await getRule(builderId, id);
  if (!rule) notFound();

  const [channelRows, webhookRows] = await Promise.all([
    listChannelsForRule(builderId, id),
    withRLS(builderId, async (tx) =>
      tx
        .select({
          id: webhookConfigs.id,
          url: webhookConfigs.url,
          enabled: webhookConfigs.enabled,
        })
        .from(webhookConfigs)
        .where(eq(webhookConfigs.builder_id, builderId)),
    ),
  ]);

  const channels: ChannelRow[] = channelRows.map((c) => ({
    id: c.id,
    channel: c.channel as ChannelRow['channel'],
    enabled: c.enabled,
    webhook_config_id: c.webhook_config_id,
    email_recipients: c.email_recipients,
    slack_webhook_url: c.slack_webhook_url,
  }));
  const webhookOptions: WebhookOption[] = webhookRows.map((w) => ({
    id: w.id,
    url: w.url,
    enabled: w.enabled,
  }));

  const isOwner = role === Role.OWNER;
  const isDraft = rule.status === RuleStatus.DRAFT;
  const isDisabled = !rule.enabled && !isDraft;

  return (
    <>
      <div className="text-xs">
        <a
          href={`/o/${slug}/dashboard/rules`}
          className="text-[color:var(--muted-foreground)] hover:underline"
        >
          {COPY.rule_detail_back}
        </a>
      </div>

      <div className="mt-2 flex items-baseline justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{rule.name}</h1>
          <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
            {rule.type} · {rule.enforcement}
            {rule.customer_id ? ` · end-user ${rule.customer_id}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {isDraft ? (
            <RuleActivateButton ruleId={rule.id} status={rule.status} ruleName={rule.name} />
          ) : (
            <RuleToggle ruleId={rule.id} initial={rule.enabled} />
          )}
        </div>
      </div>

      {isDisabled ? (
        <p className="mt-3 rounded-md border border-[color:var(--border)] bg-[color:var(--muted)] px-3 py-2 text-xs text-[color:var(--muted-foreground)]">
          {COPY.channel_disabled_rule_banner}
        </p>
      ) : null}

      <RuleConfigSummary rule={rule} />

      <RuleChannelsManager
        ruleId={rule.id}
        channels={channels}
        webhookOptions={webhookOptions}
        canMutate={isOwner}
      />
    </>
  );
}

function RuleConfigSummary({ rule }: { rule: Rule }): React.ReactElement {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
        Configuration
      </h2>
      <dl className="mt-2 grid grid-cols-1 gap-2 rounded-md border border-[color:var(--border)] p-4 text-sm md:grid-cols-2">
        <Row label="Status">{rule.status}</Row>
        <Row label="Enabled">{rule.enabled ? 'yes' : 'no'}</Row>
        <Row label="Enforcement">{rule.enforcement}</Row>
        <Row label="End-user">{rule.customer_id ?? '— (all)'}</Row>
        <div className="md:col-span-2">
          <dt className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
            Config
          </dt>
          <dd className="mt-1">
            <pre className="overflow-x-auto rounded-md bg-[color:var(--muted)] p-3 text-xs">
              {JSON.stringify(rule.config, null, 2)}
            </pre>
          </dd>
        </div>
      </dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
        {label}
      </dt>
      <dd className="mt-1 font-medium">{children}</dd>
    </div>
  );
}
