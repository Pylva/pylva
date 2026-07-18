'use client';

import { useRef, useState } from 'react';
import { apiFetch } from '@/lib/dashboard/api-client';
import { COPY } from '@/lib/copy';
import {
  DEFAULT_MODEL_ROUTING_FALLBACK,
  OTHERS_CUSTOMER_ID,
  RuleScope,
  RuleStatus,
  RuleType,
  type SimulatorResult,
  type ModelSwap,
} from '@pylva/shared';
import { formatTelemetryUsd } from '@/lib/formatting';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ModelInfo {
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

interface Props {
  modelsByProvider: Record<string, ModelInfo[]>;
}

const MAX_SWAPS = 10;
const DEFAULT_RANGE_DAYS = 30;

function defaultDates() {
  const end = new Date();
  const start = new Date(end.getTime() - DEFAULT_RANGE_DAYS * 86_400_000);
  return {
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  };
}

interface SwapEntry {
  id: number;
  from_provider: string;
  from_model: string;
  to_provider: string;
  to_model: string;
}

export function SimulatorClient({ modelsByProvider }: Props) {
  const providers = Object.keys(modelsByProvider).sort();
  const dates = defaultDates();

  const [periodStart, setPeriodStart] = useState(dates.start);
  const [periodEnd, setPeriodEnd] = useState(dates.end);
  const [customerId, setCustomerId] = useState('');
  const [swaps, setSwaps] = useState<SwapEntry[]>([
    { id: 1, from_provider: '', from_model: '', to_provider: '', to_model: '' },
  ]);
  const [result, setResult] = useState<SimulatorResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const nextIdRef = useRef(2);

  function addSwap() {
    if (swaps.length >= MAX_SWAPS) return;
    setSwaps([
      ...swaps,
      { id: nextIdRef.current++, from_provider: '', from_model: '', to_provider: '', to_model: '' },
    ]);
  }

  function removeSwap(id: number) {
    if (swaps.length <= 1) return;
    setSwaps(swaps.filter((s) => s.id !== id));
  }

  function updateSwap(id: number, field: keyof SwapEntry, value: string) {
    setSwaps(swaps.map((s) => (s.id === id ? { ...s, [field]: value } : s)));
  }

  function buildRequestBody() {
    const validSwaps = swaps.filter(
      (s) => s.from_model && s.to_model && s.from_provider && s.to_provider,
    );
    return {
      validSwaps,
      body: {
        period_start: periodStart,
        period_end: periodEnd,
        customer_id: customerId || null,
        model_swaps: validSwaps.map(({ from_provider, from_model, to_provider, to_model }) => ({
          from_provider,
          from_model,
          to_provider,
          to_model,
        })),
      },
    };
  }

  async function runSimulation() {
    const { validSwaps, body } = buildRequestBody();
    if (validSwaps.length === 0) {
      setError('Add at least one complete model swap');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);

    try {
      const res = await apiFetch('/api/v1/simulator/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }

      const data = await res.json();
      setResult(data);
    } catch {
      setError('Failed to run simulation');
    } finally {
      setLoading(false);
    }
  }

  async function downloadCsv() {
    const { body } = buildRequestBody();
    const res = await apiFetch('/api/v1/simulator/run?format=csv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `simulation-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function saveRecommendation(swap: ModelSwap) {
    setSaving(true);
    try {
      const res = await apiFetch('/api/v1/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: RuleType.MODEL_ROUTING,
          name: `Swap ${swap.from_model} → ${swap.to_model}`,
          enabled: false,
          // Persist the real modelRoutingConfig shape (scope/match/route_to/
          // fallback) — activation re-validates against the create schema,
          // so the legacy {from_*, to_*} shape saved an unactivatable draft.
          config: {
            scope: RuleScope.POOLED,
            match: { provider: swap.from_provider, model: swap.from_model },
            route_to: { provider: swap.to_provider, model: swap.to_model },
            fallback: DEFAULT_MODEL_ROUTING_FALLBACK,
          },
          status: RuleStatus.DRAFT,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Failed to save recommendation`);
      }
    } catch {
      setError('Failed to save recommendation');
    } finally {
      setSaving(false);
    }
  }

  function modelsFor(provider: string): ModelInfo[] {
    return modelsByProvider[provider] ?? [];
  }

  return (
    <div className="mt-8 space-y-6">
      {/* Period selector */}
      <div className="flex flex-wrap gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[color:var(--muted-foreground)]">Start date</span>
          <input
            type="date"
            value={periodStart}
            onChange={(e) => setPeriodStart(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[color:var(--muted-foreground)]">End date</span>
          <input
            type="date"
            value={periodEnd}
            onChange={(e) => setPeriodEnd(e.target.value)}
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-1.5"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-[color:var(--muted-foreground)]">End-user ID (optional)</span>
          <input
            type="text"
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            placeholder="All end-users"
            className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-3 py-1.5"
          />
        </label>
      </div>

      {/* Model swaps */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Model swaps</h3>
        {swaps.map((swap) => (
          <div key={swap.id} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[color:var(--muted-foreground)]">From provider</span>
              <select
                value={swap.from_provider}
                onChange={(e) => updateSwap(swap.id, 'from_provider', e.target.value)}
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm"
              >
                <option value="">Select...</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[color:var(--muted-foreground)]">From model</span>
              <select
                value={swap.from_model}
                onChange={(e) => updateSwap(swap.id, 'from_model', e.target.value)}
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm"
              >
                <option value="">Select...</option>
                {modelsFor(swap.from_provider).map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model}
                  </option>
                ))}
              </select>
            </label>
            <span className="pb-1.5 text-sm text-[color:var(--muted-foreground)]">→</span>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[color:var(--muted-foreground)]">To provider</span>
              <select
                value={swap.to_provider}
                onChange={(e) => updateSwap(swap.id, 'to_provider', e.target.value)}
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm"
              >
                <option value="">Select...</option>
                {providers.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              <span className="text-[color:var(--muted-foreground)]">To model</span>
              <select
                value={swap.to_model}
                onChange={(e) => updateSwap(swap.id, 'to_model', e.target.value)}
                className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1.5 text-sm"
              >
                <option value="">Select...</option>
                {modelsFor(swap.to_provider).map((m) => (
                  <option key={m.model} value={m.model}>
                    {m.model} (${(m.input_per_1m / 1000).toFixed(4)}/1K in)
                  </option>
                ))}
              </select>
            </label>
            {swaps.length > 1 && (
              <button
                onClick={() => removeSwap(swap.id)}
                className="rounded-md px-2 py-1.5 text-sm text-red-500 hover:bg-red-50"
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {swaps.length < MAX_SWAPS && (
          <button onClick={addSwap} className="text-sm text-[color:var(--primary)] hover:underline">
            + Add swap
          </button>
        )}
      </div>

      {/* Run button */}
      <div className="flex gap-3">
        <button
          onClick={runSimulation}
          disabled={loading}
          className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm font-medium text-[color:var(--primary-foreground)] disabled:opacity-50"
        >
          {loading ? 'Running...' : 'Run simulation'}
        </button>
        {result && (
          <button
            onClick={downloadCsv}
            className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm"
          >
            Export CSV
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {/* Results */}
      {result && (
        <div className="space-y-6">
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <ResultCard label="Actual cost" value={formatTelemetryUsd(result.original_cost_usd)} />
            <ResultCard
              label="Projected cost"
              value={formatTelemetryUsd(result.simulated_cost_usd)}
            />
            <ResultCard
              label="Savings"
              value={formatTelemetryUsd(result.savings_usd)}
              accent={result.savings_usd > 0 ? 'green' : result.savings_usd < 0 ? 'red' : undefined}
            />
            <ResultCard label="Savings %" value={`${result.savings_percent}%`} />
          </div>

          {result.freshness_timestamp && (
            <p className="text-xs text-[color:var(--muted-foreground)]">
              Data as of: {result.freshness_timestamp}
            </p>
          )}

          {result.warnings.length > 0 && (
            <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
              {result.warnings.map((w, i) => (
                <p key={i}>{w}</p>
              ))}
            </div>
          )}

          {/* Breakdown table */}
          <TableContainer>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>End-user</TableHead>
                  <TableHead>Step</TableHead>
                  <TableHead>Original</TableHead>
                  <TableHead>Projected</TableHead>
                  <TableHead>Actual $</TableHead>
                  <TableHead>Projected $</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.breakdown.map((b, i) => (
                  <TableRow key={i}>
                    <TableCell className="font-mono text-xs">
                      {b.customer_id === OTHERS_CUSTOMER_ID ? 'Others' : b.customer_id}
                    </TableCell>
                    <TableCell>{b.step_name ?? 'unattributed'}</TableCell>
                    <TableCell>{b.original_model}</TableCell>
                    <TableCell>{b.simulated_model}</TableCell>
                    <TableCell className="tabular-nums">
                      {formatTelemetryUsd(b.original_cost_usd)}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {formatTelemetryUsd(b.simulated_cost_usd)}
                    </TableCell>
                    <TableCell className="tabular-nums">{b.event_count.toLocaleString()}</TableCell>
                    <TableCell>
                      {b.original_model !== b.simulated_model &&
                        b.customer_id !== OTHERS_CUSTOMER_ID && (
                          <button
                            onClick={() =>
                              saveRecommendation({
                                from_provider: b.provider,
                                from_model: b.original_model,
                                to_provider: b.provider,
                                to_model: b.simulated_model,
                              })
                            }
                            disabled={saving}
                            className="text-xs text-[color:var(--primary)] hover:underline disabled:opacity-50"
                            title={COPY.simulator_save_recommendation}
                          >
                            Save
                          </button>
                        )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </div>
      )}
    </div>
  );
}

function ResultCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'green' | 'red';
}) {
  const accentClass =
    accent === 'green' ? 'text-green-600' : accent === 'red' ? 'text-red-600' : '';

  return (
    <div className="rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-4">
      <div className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]">
        {label}
      </div>
      <div className={`mt-1 text-2xl font-semibold tabular-nums ${accentClass}`}>{value}</div>
    </div>
  );
}
