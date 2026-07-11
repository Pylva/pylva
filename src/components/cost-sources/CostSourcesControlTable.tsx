'use client';

import { useMemo, useState, useTransition } from 'react';
import {
  CostSourceTrackingStatus,
  CostSourceType,
  type CostSourceTrackingStatus as TrackingStatus,
  type CostSourceType as SourceType,
} from '@pylva/shared';
import { apiFetch } from '@/lib/dashboard/api-client';
import { formatRelative } from '@/lib/formatting';
import {
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { SourceHealthBadge } from './SourceHealthBadge';

export interface CostSourceControlRow {
  id: string;
  source_type: SourceType;
  display_name: string;
  slug: string;
  metric: string | null;
  unit: string | null;
  status: 'healthy' | 'warning' | 'broken';
  tracking_status: TrackingStatus;
  matchers: string[];
  last_seen_at: string | null;
  last_discovered_at: string | null;
  discovery_count: number;
  has_pricing: boolean;
}

type Filter = 'all' | 'tracked' | 'pending' | 'ignored' | 'llm';

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'tracked', label: 'Tracked' },
  { key: 'pending', label: 'Pending' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'llm', label: 'LLM providers' },
];

export function CostSourcesControlTable({
  slug,
  sources,
  canMutate,
}: {
  slug: string;
  sources: CostSourceControlRow[];
  canMutate: boolean;
}): React.ReactElement {
  const [filter, setFilter] = useState<Filter>('all');
  const [rows, setRows] = useState(sources);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const filtered = useMemo(
    () =>
      rows.filter((source) => {
        if (filter === 'all') return true;
        if (filter === 'llm') return source.source_type === CostSourceType.LLM_PROVIDER;
        return (
          source.source_type === CostSourceType.NON_LLM_MANUAL && source.tracking_status === filter
        );
      }),
    [filter, rows],
  );

  const setTrackingStatus = (source: CostSourceControlRow, tracking_status: TrackingStatus) => {
    setError(null);
    startTransition(async () => {
      const res = await apiFetch(`/api/v1/cost-sources?slug=${encodeURIComponent(source.slug)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ tracking_status }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? `Update failed: ${res.status}`);
        return;
      }
      setRows((prev) =>
        prev.map((row) =>
          row.id === source.id
            ? {
                ...row,
                tracking_status,
              }
            : row,
        ),
      );
    });
  };

  return (
    <div className="mt-8">
      <div className="flex flex-wrap gap-2 border-b border-[color:var(--border)] pb-3">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            className={`rounded-md px-3 py-1.5 text-sm ${
              filter === item.key
                ? 'bg-[color:var(--primary)] text-[color:var(--primary-foreground)]'
                : 'border border-[color:var(--border)] text-[color:var(--muted-foreground)] hover:bg-[color:var(--muted)]'
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {error ? <p className="mt-3 text-sm text-red-600">{error}</p> : null}

      <TableContainer className="mt-4">
        <Table className="min-w-[980px]">
          <TableHeader>
            <TableRow>
              <TableHead>Source</TableHead>
              <TableHead>Tracking</TableHead>
              <TableHead>Metric</TableHead>
              <TableHead>Matchers</TableHead>
              <TableHead>Seen</TableHead>
              <TableHead>Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((source) => (
              <TableRow key={source.id}>
                <TableCell className="align-top">
                  <div className="flex items-center gap-2">
                    <SourceHealthBadge status={source.status} />
                    <div className="min-w-0">
                      <div className="font-medium">{source.display_name}</div>
                      <div className="text-xs text-[color:var(--muted-foreground)]">
                        {source.source_type === CostSourceType.LLM_PROVIDER
                          ? 'LLM provider'
                          : 'Non-LLM tool'}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <TrackingBadge source={source} />
                  {!source.has_pricing &&
                  source.source_type === CostSourceType.NON_LLM_MANUAL &&
                  source.tracking_status !== CostSourceTrackingStatus.IGNORED ? (
                    <div className="mt-1 text-xs text-amber-700">pricing required</div>
                  ) : null}
                </TableCell>
                <TableCell className="align-top text-xs">
                  {source.metric ? (
                    <>
                      <div className="font-mono">{source.metric}</div>
                      <div className="text-[color:var(--muted-foreground)]">
                        per {source.unit ?? 'unit'}
                      </div>
                    </>
                  ) : (
                    <span className="text-[color:var(--muted-foreground)]">Not configured</span>
                  )}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex max-w-xs flex-wrap gap-1">
                    {(source.matchers.length > 0 ? source.matchers : [source.slug]).map(
                      (matcher) => (
                        <span
                          key={matcher}
                          className="rounded-sm bg-[color:var(--muted)] px-1.5 py-0.5 font-mono text-xs"
                        >
                          {matcher}
                        </span>
                      ),
                    )}
                  </div>
                </TableCell>
                <TableCell className="align-top text-xs text-[color:var(--muted-foreground)]">
                  {source.last_seen_at ? (
                    <div>seen {formatRelative(new Date(source.last_seen_at))}</div>
                  ) : source.last_discovered_at ? (
                    <div>discovered {formatRelative(new Date(source.last_discovered_at))}</div>
                  ) : (
                    <div>never</div>
                  )}
                  {source.discovery_count > 0 ? (
                    <div>{source.discovery_count.toLocaleString()} discoveries</div>
                  ) : null}
                </TableCell>
                <TableCell className="align-top">
                  <div className="flex flex-wrap gap-2">
                    {source.source_type === CostSourceType.NON_LLM_MANUAL ? (
                      <a
                        href={`/o/${slug}/dashboard/cost-sources/pricing?source=${encodeURIComponent(source.slug)}`}
                        className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-xs hover:bg-[color:var(--muted)]"
                      >
                        {source.tracking_status === CostSourceTrackingStatus.PENDING
                          ? 'Track'
                          : 'Configure'}
                      </a>
                    ) : (
                      <a
                        href={`/o/${slug}/dashboard/cost-sources/pricing?source=${encodeURIComponent(source.slug)}`}
                        className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-xs hover:bg-[color:var(--muted)]"
                      >
                        Pricing
                      </a>
                    )}
                    {canMutate &&
                    source.source_type === CostSourceType.NON_LLM_MANUAL &&
                    source.tracking_status !== CostSourceTrackingStatus.IGNORED ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => setTrackingStatus(source, CostSourceTrackingStatus.IGNORED)}
                        className="rounded-md border border-[color:var(--border)] px-2.5 py-1 text-xs text-[color:var(--muted-foreground)] hover:bg-[color:var(--muted)] disabled:opacity-50"
                      >
                        Ignore
                      </button>
                    ) : null}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {filtered.length === 0 ? (
        <p className="mt-6 text-sm text-[color:var(--muted-foreground)]">
          No cost sources match this filter.
        </p>
      ) : null}
    </div>
  );
}

function TrackingBadge({ source }: { source: CostSourceControlRow }): React.ReactElement {
  if (source.source_type === CostSourceType.LLM_PROVIDER) {
    return <Badge label="Auto tracked" className="bg-emerald-50 text-emerald-700" />;
  }
  switch (source.tracking_status) {
    case CostSourceTrackingStatus.TRACKED:
      return <Badge label="Tracked" className="bg-emerald-50 text-emerald-700" />;
    case CostSourceTrackingStatus.PENDING:
      return <Badge label="Pending" className="bg-amber-50 text-amber-700" />;
    case CostSourceTrackingStatus.IGNORED:
      return (
        <Badge
          label="Ignored"
          className="bg-[color:var(--muted)] text-[color:var(--muted-foreground)]"
        />
      );
  }
}

function Badge({ label, className }: { label: string; className: string }): React.ReactElement {
  return <span className={`rounded-sm px-2 py-0.5 text-xs ${className}`}>{label}</span>;
}
