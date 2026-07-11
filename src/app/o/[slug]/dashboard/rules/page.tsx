// B2a T3 — rules list. B4-4d-2 adds the Recommendations section,
// driven by `listAnomalies(status=open)` filtered to actionable
// recommendation actions.

import type { Metadata } from 'next';
import {
  AnomalyRecommendationAction,
  AnomalyStatus,
  RuleStatus,
  type AnomalyEvent,
  type Rule,
} from '@pylva/shared';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { listRules } from '@/lib/rules/repository';
import { listAnomalies } from '@/lib/anomaly/repository';
import { RuleToggle } from '@/components/rules/RuleToggle';
import { RuleActivateButton } from '@/components/rules/RuleActivateButton';
import { AnomalyActionButtons } from '@/components/anomalies/AnomalyActionButtons';
import { COPY } from '@/lib/copy';
import { PageHeader } from '@/components/dashboard/PageHeader';

export const metadata: Metadata = { title: 'Reactive rules' };

export default async function RulesPage({ params }: { params: Promise<{ slug: string }> }) {
  const { builderId } = await readDashboardHeaders();
  const { slug } = await params;
  const [rules, openAnomalies] = await Promise.all([
    listRules(builderId),
    listAnomalies(builderId, { status: AnomalyStatus.OPEN, limit: 50 }),
  ]);
  const recommendations = openAnomalies.filter(
    (a) => a.recommendation.action !== AnomalyRecommendationAction.DISMISS,
  );

  return (
    <>
      <PageHeader
        title={COPY.rules_page_title}
        description={COPY.rules_page_subtitle}
        action={
          <a
            href={`/o/${slug}/dashboard/rules/new`}
            className="inline-flex h-9 items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[var(--primary)] px-4 py-2 text-sm font-medium text-[var(--primary-foreground)] transition-colors hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
          >
            New rule
          </a>
        }
      />

      {rules.length === 0 && recommendations.length === 0 ? (
        <p className="mt-8 text-sm text-[color:var(--muted-foreground)]">
          No rules yet. Start from a template to catch cost spikes or enforce budgets.
        </p>
      ) : (
        <>
          {recommendations.length > 0 ? (
            <RecommendationsSection recommendations={recommendations} slug={slug} />
          ) : null}
          {rules.length > 0 ? <RulesByStatus rules={rules} slug={slug} /> : null}
        </>
      )}
    </>
  );
}

function RecommendationsSection({
  recommendations,
  slug,
}: {
  recommendations: AnomalyEvent[];
  slug: string;
}): React.ReactElement {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
        Recommendations ({recommendations.length})
      </h2>
      <p className="mt-1 text-xs text-[color:var(--muted-foreground)]">
        Open anomalies with actionable recommendations from the cost diagnosis. Apply as a draft
        rule or dismiss.
      </p>
      <ul className="mt-2 space-y-2">
        {recommendations.map((a) => (
          <RecommendationRow key={a.id} anomaly={a} slug={slug} />
        ))}
      </ul>
    </section>
  );
}

function RecommendationRow({
  anomaly,
  slug,
}: {
  anomaly: AnomalyEvent;
  slug: string;
}): React.ReactElement {
  const projected = anomaly.recommendation.projected_savings_usd;
  const summary = renderAnomalySummary(anomaly);
  return (
    <li className="app-card flex items-center justify-between px-4 py-3">
      <div className="min-w-0">
        <div className="truncate font-medium">
          {anomaly.source_type.replace(/_/g, ' ')}
          {anomaly.customer_id ? ` · ${anomaly.customer_id}` : ''}
        </div>
        <div className="text-xs text-[color:var(--muted-foreground)]">
          {summary}
          {projected != null ? ` · projected savings $${projected.toFixed(2)}` : ''}
        </div>
      </div>
      <AnomalyActionButtons anomaly={anomaly} slug={slug} />
    </li>
  );
}

function renderAnomalySummary(anomaly: AnomalyEvent): string {
  const parts: string[] = [];
  if (anomaly.actual_value != null && anomaly.baseline_value != null) {
    parts.push(
      `actual $${anomaly.actual_value.toFixed(2)} vs baseline $${anomaly.baseline_value.toFixed(2)}`,
    );
  }
  if (anomaly.delta_pct != null) {
    const sign = anomaly.delta_pct >= 0 ? '+' : '';
    parts.push(`${sign}${anomaly.delta_pct}%`);
  }
  const top = anomaly.diagnosis.top_drivers?.[0];
  if (top) parts.push(`top driver: ${top.label}`);
  return parts.join(' · ');
}

function RulesByStatus({ rules, slug }: { rules: Rule[]; slug: string }): React.ReactElement {
  const drafts = rules.filter((r) => r.status === RuleStatus.DRAFT);
  const active = rules.filter((r) => r.status !== RuleStatus.DRAFT);
  return (
    <>
      {drafts.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
            Drafts ({drafts.length})
          </h2>
          <ul className="mt-2 space-y-2">
            {drafts.map((rule) => (
              <RuleRow key={rule.id} rule={rule} slug={slug} />
            ))}
          </ul>
        </section>
      ) : null}
      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Active ({active.length})
        </h2>
        <ul className="mt-2 space-y-2">
          {active.map((rule) => (
            <RuleRow key={rule.id} rule={rule} slug={slug} />
          ))}
        </ul>
      </section>
    </>
  );
}

function RuleRow({ rule, slug }: { rule: Rule; slug: string }): React.ReactElement {
  return (
    <li className="app-card flex items-center justify-between px-4 py-3">
      <div className="min-w-0">
        <a
          href={`/o/${slug}/dashboard/rules/${rule.id}`}
          className="truncate font-medium hover:underline"
        >
          {rule.name}
        </a>
        <div className="text-xs text-[color:var(--muted-foreground)]">
          {rule.type} · {renderConfigSummary(rule.config)}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        {rule.status === RuleStatus.DRAFT ? (
          <RuleActivateButton ruleId={rule.id} status={rule.status} ruleName={rule.name} />
        ) : (
          <RuleToggle ruleId={rule.id} initial={rule.enabled} />
        )}
      </div>
    </li>
  );
}

function renderConfigSummary(config: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof config['limit_usd'] === 'number') parts.push(`limit $${config['limit_usd']}`);
  if (typeof config['threshold_usd'] === 'number')
    parts.push(`threshold $${config['threshold_usd']}`);
  if (typeof config['margin_threshold_pct'] === 'number')
    parts.push(`margin ${config['margin_threshold_pct']}%`);
  if (typeof config['period'] === 'string') parts.push(`per ${config['period']}`);
  if (config['scope'] === 'pooled') parts.push('pooled');
  if (config['hard_stop'] === true) parts.push('hard_stop');
  return parts.join(' · ');
}
