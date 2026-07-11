// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — Preview Impact inline panel.
//
// Consumes the PricingPreviewResponse from the parent PricingEditor. Shows
// current vs proposed amount + delta + line-item diff. Not interactive —
// render-only.

'use client';

import type { PricingPreviewResponse } from '@pylva/shared';
import { formatUsd } from '@/lib/formatting';

export function PreviewImpactPanel({ preview }: { preview: PricingPreviewResponse | null }) {
  if (!preview) {
    return (
      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6 text-sm text-[color:var(--muted-foreground)]">
        Enter pricing details to see the impact of this change.
      </div>
    );
  }

  const delta = preview.delta_usd;
  const color = delta > 0 ? 'text-red-600' : delta < 0 ? 'text-green-600' : '';

  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6">
      <h3 className="text-sm font-semibold">Preview — last 30 days</h3>
      <p className="mt-1 text-xs text-[color:var(--muted-foreground)]">
        Sampled {new Date(preview.sample_period_start).toLocaleDateString()} —{' '}
        {new Date(preview.sample_period_end).toLocaleDateString()} of priced usage.
      </p>
      <div className="mt-4 grid grid-cols-3 gap-4 text-sm">
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">Current</span>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            {formatUsd(preview.current.amount_usd)}
          </p>
        </div>
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">Proposed</span>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            {formatUsd(preview.proposed.amount_usd)}
          </p>
        </div>
        <div>
          <span className="text-xs uppercase text-[color:var(--muted-foreground)]">Δ</span>
          <p className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>
            {formatUsd(delta, { sign: true })}
          </p>
        </div>
      </div>
    </div>
  );
}
