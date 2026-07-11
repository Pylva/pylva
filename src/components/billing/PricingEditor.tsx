// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — unified pricing editor (all 4 models in one component).
//
// The plan calls for four separate form components (Flat / PayAsYouGo /
// CreditPack / Hybrid). Inlining them into a single state-machined form is
// simpler and avoids prop-drilling. We switch the inner fields based on
// `pricing_model` — same discriminator the Valibot validator uses.
//
// Emits a preview fetch on form change (debounced) and a Save button that
// POSTs to /api/v1/customers/[id]/pricing. On success pops an UndoToast
// with a 10s window.

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PricingModel, type PricingPreviewResponse } from '@pylva/shared';
import { apiFetch } from '@/lib/dashboard/api-client';
import { UndoToast } from './UndoToast';
import { PreviewImpactPanel } from './PreviewImpactPanel';

type Model = (typeof PricingModel)[keyof typeof PricingModel];

interface FormState {
  pricing_model: Model;
  flat_rate_usd: string;
  per_unit_rates: string; // "metric:rate, metric:rate" raw input
  markup_pct: string;
  pack_price_usd: string;
  included_credits: string;
  overage_rate_usd: string;
  base_fee_usd: string;
}

interface Props {
  customerId: string;
  /** current version shape for pre-fill (may be null if first-time setup). */
  initial: Record<string, unknown> | null;
}

function parseRates(raw: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const [k, v] = pair.split(':').map((s) => s.trim());
    const n = Number(v);
    if (k && !Number.isNaN(n)) out[k] = n;
  }
  return out;
}

function ratesToString(rates: Record<string, number> | null | undefined): string {
  if (!rates) return '';
  return Object.entries(rates)
    .map(([k, v]) => `${k}:${v}`)
    .join(', ');
}

function toBody(s: FormState): Record<string, unknown> {
  switch (s.pricing_model) {
    case 'flat':
      return { pricing_model: 'flat', flat_rate_usd: Number(s.flat_rate_usd) };
    case 'pay_as_you_go':
      return {
        pricing_model: 'pay_as_you_go',
        per_unit_rates: parseRates(s.per_unit_rates),
        markup_pct: Number(s.markup_pct || 0),
      };
    case 'credit_pack':
      return {
        pricing_model: 'credit_pack',
        pack_price_usd: Number(s.pack_price_usd),
        included_credits: Number(s.included_credits),
        overage_rate_usd: Number(s.overage_rate_usd),
      };
    case 'hybrid':
      return {
        pricing_model: 'hybrid',
        base_fee_usd: Number(s.base_fee_usd),
        included_credits: Number(s.included_credits),
        overage_rate_usd: Number(s.overage_rate_usd),
      };
  }
}

export function PricingEditor({ customerId, initial }: Props) {
  const initialState: FormState = useMemo(
    () => ({
      pricing_model: (initial?.['pricing_model'] as Model) ?? 'pay_as_you_go',
      flat_rate_usd: String(initial?.['flat_rate_usd'] ?? ''),
      per_unit_rates: ratesToString(initial?.['per_unit_rates'] as Record<string, number> | null),
      markup_pct: String(initial?.['markup_pct'] ?? '0'),
      pack_price_usd: String(initial?.['pack_price_usd'] ?? ''),
      included_credits: String(initial?.['included_credits'] ?? ''),
      overage_rate_usd: String(initial?.['overage_rate_usd'] ?? ''),
      base_fee_usd: String(initial?.['base_fee_usd'] ?? ''),
    }),
    [initial],
  );

  const [state, setState] = useState<FormState>(initialState);
  const [preview, setPreview] = useState<PricingPreviewResponse | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [undoOpen, setUndoOpen] = useState(false);

  const fetchPreview = useCallback(async () => {
    try {
      const body = toBody(state);
      // btoa() is the browser's base64 encoder. Node's Buffer isn't defined
      // in client components; using it here would crash at runtime.
      const proposed = btoa(JSON.stringify(body));
      const res = await apiFetch(
        `/api/v1/billing/pricing/preview?customer_id=${customerId}&proposed=${encodeURIComponent(proposed)}`,
      );
      if (!res.ok) {
        setPreview(null);
        return;
      }
      const data = (await res.json()) as PricingPreviewResponse;
      setPreview(data);
    } catch {
      setPreview(null);
    }
  }, [customerId, state]);

  // Debounce preview fetch on form change.
  useEffect(() => {
    const t = setTimeout(fetchPreview, 400);
    return () => clearTimeout(t);
  }, [fetchPreview]);

  async function save() {
    setSaveStatus('saving');
    setError(null);
    try {
      const res = await apiFetch(`/api/v1/customers/${customerId}/pricing`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toBody(state)),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      }
      setSaveStatus('saved');
      setUndoOpen(true);
    } catch (err) {
      setSaveStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6">
        <label className="flex flex-col gap-1 text-sm">
          Pricing model
          <select
            value={state.pricing_model}
            onChange={(e) => setState((s) => ({ ...s, pricing_model: e.target.value as Model }))}
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
          >
            <option value={PricingModel.FLAT}>Flat</option>
            <option value={PricingModel.PAY_AS_YOU_GO}>Pay as you go</option>
            <option value={PricingModel.CREDIT_PACK}>Credit pack</option>
            <option value={PricingModel.HYBRID}>Hybrid</option>
          </select>
        </label>

        {state.pricing_model === 'flat' ? (
          <label className="mt-4 flex flex-col gap-1 text-sm">
            Monthly fee (USD)
            <input
              type="number"
              step="0.01"
              min="0"
              value={state.flat_rate_usd}
              onChange={(e) => setState((s) => ({ ...s, flat_rate_usd: e.target.value }))}
              className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
            />
          </label>
        ) : null}

        {state.pricing_model === 'pay_as_you_go' ? (
          <>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Per-unit rates (metric:rate, comma-separated)
              <input
                type="text"
                value={state.per_unit_rates}
                onChange={(e) => setState((s) => ({ ...s, per_unit_rates: e.target.value }))}
                placeholder="input_tokens:0.003, output_tokens:0.015"
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Markup %
              <input
                type="number"
                step="0.01"
                min="0"
                value={state.markup_pct}
                onChange={(e) => setState((s) => ({ ...s, markup_pct: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
          </>
        ) : null}

        {state.pricing_model === 'credit_pack' ? (
          <>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Pack price (USD)
              <input
                type="number"
                step="0.01"
                min="0"
                value={state.pack_price_usd}
                onChange={(e) => setState((s) => ({ ...s, pack_price_usd: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Included credits
              <input
                type="number"
                min="0"
                value={state.included_credits}
                onChange={(e) => setState((s) => ({ ...s, included_credits: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Overage rate per credit (USD)
              <input
                type="number"
                step="0.0001"
                min="0"
                value={state.overage_rate_usd}
                onChange={(e) => setState((s) => ({ ...s, overage_rate_usd: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
          </>
        ) : null}

        {state.pricing_model === 'hybrid' ? (
          <>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Base fee (USD)
              <input
                type="number"
                step="0.01"
                min="0"
                value={state.base_fee_usd}
                onChange={(e) => setState((s) => ({ ...s, base_fee_usd: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Included credits
              <input
                type="number"
                min="0"
                value={state.included_credits}
                onChange={(e) => setState((s) => ({ ...s, included_credits: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
            <label className="mt-4 flex flex-col gap-1 text-sm">
              Overage rate per credit (USD)
              <input
                type="number"
                step="0.0001"
                min="0"
                value={state.overage_rate_usd}
                onChange={(e) => setState((s) => ({ ...s, overage_rate_usd: e.target.value }))}
                className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
              />
            </label>
          </>
        ) : null}

        <div className="mt-6 flex items-center gap-3">
          <button
            type="button"
            onClick={save}
            disabled={saveStatus === 'saving'}
            className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
          >
            {saveStatus === 'saving' ? 'Saving…' : 'Save pricing'}
          </button>
          {saveStatus === 'error' && error ? (
            <span className="text-xs text-red-600">{error}</span>
          ) : null}
        </div>
      </div>

      <PreviewImpactPanel preview={preview} />
      {undoOpen ? <UndoToast customerId={customerId} onDismiss={() => setUndoOpen(false)} /> : null}
    </div>
  );
}
