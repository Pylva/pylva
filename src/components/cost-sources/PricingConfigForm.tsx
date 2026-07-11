'use client';

import { useMemo, useState } from 'react';
import {
  CostSourceTrackingStatus,
  CostSourceType,
  type CostSourceTrackingStatus as TrackingStatus,
  type CostSourceType as SourceType,
  type PricingTier,
} from '@pylva/shared';
import { apiFetch } from '@/lib/dashboard/api-client';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

const MAX_TIERS = 5;
const TEMPLATES = ['flat', 'volume', 'free_paid', 'advanced'] as const;
type Template = (typeof TEMPLATES)[number];

interface PricingConfigFormProps {
  slug: string;
  sourceType: SourceType;
  displayName: string;
  metric: string | null;
  unit: string | null;
  trackingStatus: TrackingStatus;
  matchers: string[];
  defaultMetricValue: number | null;
  initialPricePerUnit: number | null;
  initialTiers: PricingTier[] | null;
  readOnly?: boolean;
}

interface TierDraft {
  from: string;
  to: string;
  price: string;
}

interface ValidationError {
  reason: string;
  index?: number;
}

function templateTiers(template: Template): TierDraft[] {
  switch (template) {
    case 'flat':
      return [];
    case 'volume':
      return [
        { from: '0', to: '10000', price: '0.001' },
        { from: '10000', to: '100000', price: '0.0008' },
        { from: '100000', to: '', price: '0.0005' },
      ];
    case 'free_paid':
      return [
        { from: '0', to: '1000', price: '0' },
        { from: '1000', to: '', price: '0.001' },
      ];
    case 'advanced':
      return [{ from: '0', to: '', price: '0' }];
  }
}

function tiersToDraft(tiers: PricingTier[] | null): TierDraft[] {
  if (!tiers || tiers.length === 0) return [];
  return tiers.map((t) => ({
    from: String(t.from),
    to: t.to === null ? '' : String(t.to),
    price: String(t.price),
  }));
}

function validateTiers(draft: TierDraft[]): ValidationError | null {
  if (draft.length === 0) return null;
  for (let i = 0; i < draft.length; i++) {
    const t = draft[i]!;
    const from = Number(t.from);
    const to = t.to === '' ? null : Number(t.to);
    const price = Number(t.price);
    if (!Number.isFinite(from) || from < 0)
      return { reason: 'from must be a non-negative number', index: i };
    if (to !== null && (!Number.isFinite(to) || to <= from)) {
      return {
        reason: 'to must be greater than from (or empty for open-ended top tier)',
        index: i,
      };
    }
    if (!Number.isFinite(price) || price < 0)
      return { reason: 'price must be non-negative', index: i };
    if (i > 0) {
      const prev = draft[i - 1]!;
      const prevTo = prev.to === '' ? null : Number(prev.to);
      if (prevTo === null)
        return { reason: 'open-ended tier (to=blank) must be the last row', index: i - 1 };
      if (Number(t.from) !== prevTo)
        return { reason: 'tier ranges must be contiguous (no gaps or overlaps)', index: i };
    }
  }
  return null;
}

function draftToPayload(draft: TierDraft[]): PricingTier[] {
  return draft.map((t) => ({
    from: Number(t.from),
    to: t.to === '' ? null : Number(t.to),
    price: Number(t.price),
  }));
}

export function PricingConfigForm({
  slug,
  sourceType,
  displayName,
  metric,
  unit,
  trackingStatus,
  matchers,
  defaultMetricValue,
  initialPricePerUnit,
  initialTiers,
  readOnly = false,
}: PricingConfigFormProps): React.ReactElement {
  const isNonLlm = sourceType === CostSourceType.NON_LLM_MANUAL;
  const initialMode: 'flat' | 'tiered' =
    initialTiers && initialTiers.length > 0 ? 'tiered' : 'flat';
  const [nameDraft, setNameDraft] = useState(displayName);
  const [metricDraft, setMetricDraft] = useState(metric ?? '');
  const [unitDraft, setUnitDraft] = useState(unit ?? '');
  const [matcherDraft, setMatcherDraft] = useState(
    (matchers.length > 0 ? matchers : [slug]).join('\n'),
  );
  const [defaultValueDraft, setDefaultValueDraft] = useState(
    defaultMetricValue !== null ? String(defaultMetricValue) : '1',
  );
  const [mode, setMode] = useState<'flat' | 'tiered'>(initialMode);
  const [flatPrice, setFlatPrice] = useState<string>(
    initialPricePerUnit !== null ? String(initialPricePerUnit) : '',
  );
  const [tiers, setTiers] = useState<TierDraft[]>(tiersToDraft(initialTiers));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validationError = useMemo<ValidationError | null>(
    () => (mode === 'tiered' ? validateTiers(tiers) : null),
    [mode, tiers],
  );

  const parsedMatchers = useMemo(
    () =>
      matcherDraft
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean),
    [matcherDraft],
  );

  const applyTemplate = (template: Template): void => {
    if (template === 'flat') {
      setMode('flat');
      setTiers([]);
      return;
    }
    setMode('tiered');
    setTiers(templateTiers(template));
  };

  const updateTier = (index: number, patch: Partial<TierDraft>): void => {
    setTiers((prev) => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)));
  };

  const addTier = (): void => {
    if (tiers.length >= MAX_TIERS) return;
    const last = tiers[tiers.length - 1];
    const nextFrom = last ? (last.to === '' ? '0' : last.to) : '0';
    setTiers((prev) => {
      const next = [...prev];
      if (next.length > 0 && next[next.length - 1]!.to === '') {
        next[next.length - 1] = { ...next[next.length - 1]!, to: nextFrom };
      }
      next.push({ from: nextFrom, to: '', price: '0' });
      return next;
    });
  };

  const removeTier = (index: number): void => {
    setTiers((prev) => prev.filter((_, i) => i !== index));
  };

  const validateBeforeSave = (): string | null => {
    if (validationError) return validationError.reason;
    if (!isNonLlm) return null;
    if (!metricDraft.trim()) return 'Metric is required before tracking this source.';
    if (!unitDraft.trim()) return 'Unit is required before tracking this source.';
    if (parsedMatchers.length === 0) return 'At least one matcher is required.';
    if (mode === 'flat' && flatPrice === '') return 'Flat price is required before tracking.';
    if (mode === 'tiered' && tiers.length === 0) return 'At least one tier is required.';
    const defaultValue = Number(defaultValueDraft);
    if (!Number.isFinite(defaultValue) || defaultValue < 0) {
      return 'Default usage value must be a non-negative number.';
    }
    return null;
  };

  const save = async (nextStatus?: TrackingStatus): Promise<void> => {
    const localError =
      nextStatus === CostSourceTrackingStatus.IGNORED ? null : validateBeforeSave();
    if (localError) {
      setError(localError);
      return;
    }
    setSaving(true);
    setError(null);
    setSavedAt(null);

    const body: Record<string, unknown> =
      mode === 'tiered'
        ? { pricing_tiers: draftToPayload(tiers), price_per_unit: null }
        : { pricing_tiers: null, price_per_unit: flatPrice === '' ? null : Number(flatPrice) };

    if (isNonLlm) {
      body.display_name = nameDraft;
      body.metric = metricDraft.trim();
      body.unit = unitDraft.trim();
      body.matchers = parsedMatchers;
      body.default_metric_value = Number(defaultValueDraft);
      body.tracking_status = nextStatus ?? CostSourceTrackingStatus.TRACKED;
    }

    try {
      const response = await apiFetch(`/api/v1/cost-sources?slug=${encodeURIComponent(slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errBody = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(errBody?.error?.message ?? `Save failed: ${response.status}`);
        return;
      }
      setSavedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {isNonLlm ? (
        <div className="grid gap-4 md:grid-cols-2">
          <label className="block text-sm font-medium">
            Display name
            <input
              value={nameDraft}
              onChange={(e) => setNameDraft(e.target.value)}
              readOnly={readOnly}
              disabled={readOnly}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm disabled:opacity-50"
            />
          </label>
          <label className="block text-sm font-medium">
            Default usage value
            <input
              type="number"
              min="0"
              step="1"
              value={defaultValueDraft}
              onChange={(e) => setDefaultValueDraft(e.target.value)}
              readOnly={readOnly}
              disabled={readOnly}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm disabled:opacity-50"
            />
          </label>
          <label className="block text-sm font-medium">
            Metric
            <input
              value={metricDraft}
              onChange={(e) => setMetricDraft(e.target.value)}
              placeholder="tavily_requests"
              readOnly={readOnly}
              disabled={readOnly}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 font-mono text-sm disabled:opacity-50"
            />
          </label>
          <label className="block text-sm font-medium">
            Unit
            <input
              value={unitDraft}
              onChange={(e) => setUnitDraft(e.target.value)}
              placeholder="request"
              readOnly={readOnly}
              disabled={readOnly}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm disabled:opacity-50"
            />
          </label>
          <label className="block text-sm font-medium md:col-span-2">
            Matchers
            <textarea
              value={matcherDraft}
              onChange={(e) => setMatcherDraft(e.target.value)}
              readOnly={readOnly}
              disabled={readOnly}
              rows={3}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 font-mono text-sm disabled:opacity-50"
            />
          </label>
        </div>
      ) : null}

      <div>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Pricing
        </h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {TEMPLATES.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => applyTemplate(t)}
              disabled={readOnly}
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm hover:bg-[color:var(--accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {templateLabel(t)}
            </button>
          ))}
        </div>
      </div>

      {mode === 'flat' ? (
        <div>
          <label className="block text-sm font-medium">
            Price per {unitDraft || unit || 'unit'}
          </label>
          <input
            type="number"
            step="0.000001"
            min="0"
            value={flatPrice}
            onChange={(e) => setFlatPrice(e.target.value)}
            readOnly={readOnly}
            disabled={readOnly}
            className="mt-1 w-48 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm disabled:opacity-50"
            placeholder="0.001"
          />
        </div>
      ) : (
        <TierTable
          tiers={tiers}
          unit={unitDraft || unit}
          readOnly={readOnly}
          onUpdate={updateTier}
          onRemove={removeTier}
          highlightIndex={validationError?.index ?? null}
        />
      )}

      {mode === 'tiered' && !readOnly ? (
        <button
          type="button"
          onClick={addTier}
          disabled={tiers.length >= MAX_TIERS}
          className="rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-3 py-1.5 text-sm hover:bg-[color:var(--accent)] disabled:opacity-50"
        >
          Add tier {tiers.length >= MAX_TIERS ? `(max ${MAX_TIERS})` : ''}
        </button>
      ) : null}

      {error || validationError ? (
        <p className="text-sm text-red-600">{error ?? validationError?.reason}</p>
      ) : savedAt ? (
        <p className="text-sm text-emerald-700">Saved at {savedAt.toLocaleTimeString()}</p>
      ) : null}

      <p className="text-xs text-[color:var(--muted-foreground)]">
        Price changes apply to new events only. Historical costs are not retroactively recalculated.
      </p>

      {readOnly ? null : (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => save()}
            disabled={saving || (mode === 'tiered' && validationError !== null)}
            className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm font-medium text-[color:var(--primary-foreground)] hover:opacity-90 disabled:opacity-50"
          >
            {saving
              ? 'Saving...'
              : isNonLlm && trackingStatus !== CostSourceTrackingStatus.TRACKED
                ? 'Track source'
                : 'Save'}
          </button>
          {isNonLlm && trackingStatus !== CostSourceTrackingStatus.IGNORED ? (
            <button
              type="button"
              onClick={() => save(CostSourceTrackingStatus.IGNORED)}
              disabled={saving}
              className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm text-[color:var(--muted-foreground)] hover:bg-[color:var(--muted)] disabled:opacity-50"
            >
              Ignore future calls
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

function templateLabel(t: Template): string {
  switch (t) {
    case 'flat':
      return 'Flat rate';
    case 'volume':
      return 'Volume discount';
    case 'free_paid':
      return 'Free tier + paid';
    case 'advanced':
      return 'Custom tiers';
  }
}

interface TierTableProps {
  tiers: TierDraft[];
  unit: string | null;
  readOnly: boolean;
  onUpdate: (index: number, patch: Partial<TierDraft>) => void;
  onRemove: (index: number) => void;
  highlightIndex: number | null;
}

function TierTable({
  tiers,
  unit,
  readOnly,
  onUpdate,
  onRemove,
  highlightIndex,
}: TierTableProps): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>From ({unit ?? 'units'})</TableHead>
          <TableHead>To</TableHead>
          <TableHead>Price/{unit ?? 'unit'}</TableHead>
          <TableHead>
            <span className="sr-only">Remove</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {tiers.map((tier, i) => {
          const isHighlight = highlightIndex === i;
          return (
            <TableRow key={i} className={isHighlight ? 'bg-red-50' : ''}>
              <TableCell className="py-1">
                <input
                  type="number"
                  min="0"
                  value={tier.from}
                  onChange={(e) => onUpdate(i, { from: e.target.value })}
                  readOnly={readOnly}
                  disabled={readOnly}
                  className="w-32 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1 disabled:opacity-50"
                />
              </TableCell>
              <TableCell className="py-1">
                <input
                  type="number"
                  min="0"
                  value={tier.to}
                  onChange={(e) => onUpdate(i, { to: e.target.value })}
                  placeholder="open-ended"
                  readOnly={readOnly}
                  disabled={readOnly}
                  className="w-32 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1 disabled:opacity-50"
                />
              </TableCell>
              <TableCell className="py-1">
                <input
                  type="number"
                  step="0.000001"
                  min="0"
                  value={tier.price}
                  onChange={(e) => onUpdate(i, { price: e.target.value })}
                  readOnly={readOnly}
                  disabled={readOnly}
                  className="w-32 rounded-md border border-[color:var(--border)] bg-[color:var(--card)] px-2 py-1 disabled:opacity-50"
                />
              </TableCell>
              <TableCell className="py-1">
                {!readOnly ? (
                  <button
                    type="button"
                    onClick={() => onRemove(i)}
                    className="text-xs text-red-600 hover:underline"
                  >
                    Remove
                  </button>
                ) : null}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
