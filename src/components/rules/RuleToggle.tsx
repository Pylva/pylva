// B2a T3 — enable/disable toggle. Members are allowed to toggle (the rule
// repository allows the toggle without Owner-only gate; only destructive
// ops are Owner-gated).

'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/dashboard/api-client';

export function RuleToggle({ ruleId, initial }: { ruleId: string; initial: boolean }) {
  const [enabled, setEnabled] = useState(initial);
  const [pending, setPending] = useState(false);

  async function onToggle() {
    const next = !enabled;
    setPending(true);
    try {
      const res = await apiFetch(`/api/v1/rules/${ruleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (res.ok) setEnabled(next);
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={pending}
      className={`rounded-full px-3 py-1 text-xs uppercase tracking-wider ${
        enabled
          ? 'bg-[color:var(--primary)] text-[color:var(--primary-foreground)]'
          : 'bg-[color:var(--muted)] text-[color:var(--muted-foreground)]'
      } disabled:opacity-50`}
      aria-pressed={enabled}
    >
      {enabled ? 'Enabled' : 'Disabled'}
    </button>
  );
}
