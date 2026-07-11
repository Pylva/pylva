'use client';

// Promote-draft → active button. Calls POST /api/v1/rules/{id}/activate
// which runs the impact preview server-side, gates the tier (advanced
// types require pro+) + failover-consent re-validation, then flips the
// status. The full impact-summary modal is a follow-up — for now the
// confirmation surface is the native confirm() with the affected-customer
// count fetched up front.

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation.js';
import { apiFetch } from '@/lib/dashboard/api-client';
import { RuleStatus } from '@pylva/shared';
import type { RuleStatus as RuleStatusType } from '@pylva/shared';

interface PreviewLite {
  affected_customer_count: number;
  description: string;
  warnings: string[];
  live_traffic_warning: boolean;
}

export function RuleActivateButton({
  ruleId,
  status,
  ruleName,
}: {
  ruleId: string;
  status: RuleStatusType;
  // Track 3 PR 3.2 (O10): when provided, the button prompts the user to
  // re-type this name to confirm activation. When omitted (legacy
  // callers), the prompt asks for the name as a free-text input.
  ruleName?: string;
}): React.ReactElement {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track 3 PR 3.2 (O37): stable per-form-instance Idempotency-Key. Using
  // Date.now() generated a fresh key on every click — replay protection
  // never fired because two double-clicks produced two distinct keys. A
  // useMemo'd UUID is the same across re-renders within this component
  // mount, so genuine retries (network blip, slow dashboard) hit the
  // server's same-status no-op path with the same key.
  const idempotencyKey = useMemo(() => `rule-activate-${ruleId}-${crypto.randomUUID()}`, [ruleId]);

  async function loadPreview(): Promise<PreviewLite | null> {
    const res = await apiFetch(`/api/v1/rules/${ruleId}/preview`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      preview?: {
        affected_customers?: unknown[];
        matched_customers?: number;
        description?: string;
        warnings?: string[];
        live_traffic_warning?: boolean;
      };
    };
    if (!body.preview) return null;
    return {
      // matched_customers is the uncapped uniqExact count (B11); the
      // affected_customers list is a top-20 display sample.
      affected_customer_count:
        typeof body.preview.matched_customers === 'number'
          ? body.preview.matched_customers
          : Array.isArray(body.preview.affected_customers)
            ? body.preview.affected_customers.length
            : 0,
      description: body.preview.description ?? '',
      warnings: body.preview.warnings ?? [],
      live_traffic_warning: body.preview.live_traffic_warning ?? false,
    };
  }

  async function activate(): Promise<void> {
    if (status === RuleStatus.ACTIVE) return;
    setBusy(true);
    setError(null);

    try {
      const preview = await loadPreview();
      const summary = preview
        ? [
            preview.description,
            `Affected customers: ${preview.affected_customer_count}`,
            preview.live_traffic_warning
              ? 'This will affect live SDK traffic.'
              : 'Alert-only — does not change SDK calls.',
            ...preview.warnings,
          ].join('\n\n')
        : 'Activate this rule?';

      if (!confirm(summary + '\n\nActivate?')) {
        return;
      }

      // Track 3 PR 3.2 (O10): require the user to retype the rule name.
      const expected = ruleName ?? '';
      const typed = (
        window.prompt(
          expected
            ? `Type the rule name "${expected}" to confirm activation:`
            : 'Type the rule name exactly to confirm activation:',
        ) ?? ''
      ).trim();
      if (!typed || (expected && typed !== expected)) {
        setError('Activation cancelled — name did not match.');
        return;
      }

      const res = await apiFetch(`/api/v1/rules/${ruleId}/activate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Track 3 PR 3.2 (O37): replays of the same activation return
          // the no-op response; cross-replay flapping is forensics-only.
          'Idempotency-Key': idempotencyKey,
        },
        credentials: 'include',
        body: JSON.stringify({ status: RuleStatus.ACTIVE, confirm_name: typed }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(data?.error?.message ?? `Activation failed (HTTP ${res.status})`);
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Activation failed');
    } finally {
      setBusy(false);
    }
  }

  if (status === RuleStatus.ACTIVE) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
        Active
      </span>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden />
        Draft
      </span>
      <button
        type="button"
        onClick={activate}
        disabled={busy}
        className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1 text-xs hover:bg-[color:var(--accent)] disabled:opacity-50"
      >
        {busy ? 'Activating…' : 'Activate'}
      </button>
      {error ? <span className="text-xs text-red-600">{error}</span> : null}
    </div>
  );
}
