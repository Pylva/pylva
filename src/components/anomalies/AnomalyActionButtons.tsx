'use client';

// "Apply as rule" + "Dismiss" buttons for an anomaly recommendation row.
// Mirrors the RuleActivateButton pattern: native confirm + raw fetch +
// router.refresh on success. Apply-as-rule navigates to the new draft
// rule's edit page so the builder can review and tweak before
// activating.

import { useState } from 'react';
import { useRouter } from 'next/navigation.js';
import { AnomalyRecommendationAction, type AnomalyEvent } from '@pylva/shared';
import { apiFetch } from '@/lib/dashboard/api-client';

interface Props {
  anomaly: AnomalyEvent;
  /** Builder slug — used to navigate to the new rule after conversion. */
  slug: string;
}

export function AnomalyActionButtons({ anomaly, slug }: Props): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'dismiss' | 'apply'>(null);
  const [error, setError] = useState<string | null>(null);

  const canApply =
    anomaly.recommendation.action === AnomalyRecommendationAction.CREATE_DRAFT_MODEL_ROUTING_RULE;

  async function dismiss(): Promise<void> {
    if (busy) return;
    if (!confirm('Dismiss this anomaly? It can recur in a future period if the conditions return.'))
      return;
    setBusy('dismiss');
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/anomalies/${anomaly.id}/dismiss`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(data?.error?.message ?? `Dismiss failed (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dismiss failed');
    } finally {
      setBusy(null);
    }
  }

  async function applyAsRule(): Promise<void> {
    if (busy) return;
    const projected = anomaly.recommendation.projected_savings_usd;
    const ab = anomaly.recommendation.ab_suggestion?.rationale;
    const summary = [
      `Create a draft model_routing rule from this recommendation?`,
      projected != null ? `Projected savings: $${projected.toFixed(2)}/period.` : null,
      ab,
      `The rule will be created as a DRAFT — review and activate it manually on the rules page.`,
    ]
      .filter(Boolean)
      .join('\n\n');
    if (!confirm(summary)) return;

    setBusy('apply');
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/anomalies/${anomaly.id}/convert-to-rule`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(data?.error?.message ?? `Apply failed (HTTP ${res.status})`);
        return;
      }
      const body = (await res.json()) as { rule?: { id?: string } };
      const ruleId = body.rule?.id;
      if (ruleId) {
        router.push(`/o/${slug}/dashboard/rules?highlight=${ruleId}`);
        router.refresh();
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {canApply ? (
        <button
          type="button"
          onClick={applyAsRule}
          disabled={busy !== null}
          className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1 text-xs hover:bg-[color:var(--accent)] disabled:opacity-50"
        >
          {busy === 'apply' ? 'Applying…' : 'Apply as rule'}
        </button>
      ) : null}
      <button
        type="button"
        onClick={dismiss}
        disabled={busy !== null}
        className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs text-[color:var(--muted-foreground)] hover:bg-[color:var(--accent)] disabled:opacity-50"
      >
        {busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
