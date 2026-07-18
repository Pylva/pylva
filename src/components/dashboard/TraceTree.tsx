// B2a T1 — trace tree component (D23 flat-indented + collapsible).
// Client component because we toggle expansion locally. Pure presentational:
// takes a flat list of spans + renders a parent→child nested view.

'use client';

import { useMemo, useState } from 'react';
import type { TraceSpan } from '@/lib/clickhouse/dashboard-queries';
import type { BudgetActivity } from '@/lib/budget-activity/types';
import { formatTelemetryUsd } from '@/lib/formatting';
import { cn } from '@/lib/utils';
import { BudgetStatusBadge } from '@/components/budget-activity/BudgetStatusBadge';

interface Node {
  span: TraceSpan;
  children: Node[];
}

function buildTree(spans: TraceSpan[]): Node[] {
  const byId = new Map<string, Node>();
  for (const span of spans) byId.set(span.span_id, { span, children: [] });
  const roots: Node[] = [];
  for (const node of byId.values()) {
    const parentId = node.span.parent_span_id;
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function TraceTree({
  spans,
  controlActions = [],
}: {
  spans: TraceSpan[];
  controlActions?: BudgetActivity[];
}) {
  const roots = useMemo(() => buildTree(spans), [spans]);
  const chargedBySpan = useMemo(
    () =>
      new Map(
        controlActions
          .filter((action) => action.status === 'charged')
          .map((action) => [action.span_id, action] as const),
      ),
    [controlActions],
  );
  return (
    <ul className="space-y-0.5 font-mono text-xs">
      {roots.map((node) => (
        <TreeNode key={node.span.span_id} node={node} depth={0} chargedBySpan={chargedBySpan} />
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  chargedBySpan,
}: {
  node: Node;
  depth: number;
  chargedBySpan: ReadonlyMap<string, BudgetActivity>;
}) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const charged = chargedBySpan.get(node.span.span_id);
  return (
    <li>
      <div
        className="flex flex-wrap items-baseline gap-2"
        style={{ paddingLeft: `${depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            className="w-4 text-[color:var(--muted-foreground)] hover:text-[color:var(--foreground)]"
          >
            {expanded ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-4" />
        )}
        <span
          className={cn(
            'flex-1 truncate',
            node.span.status === 'failure' && 'text-[color:var(--destructive)]',
          )}
        >
          {node.span.step_name ?? '(unnamed)'}
          {node.span.model ? (
            <span className="text-[color:var(--muted-foreground)]"> · {node.span.model}</span>
          ) : null}
        </span>
        {charged ? <BudgetStatusBadge status="charged" /> : null}
        <span className="text-[color:var(--muted-foreground)] tabular-nums">
          {formatTelemetryUsd(node.span.cost_usd)} · {node.span.latency_ms} ms
        </span>
        {charged ? (
          <span className="basis-full pl-6 text-[10px] text-[color:var(--muted-foreground)]">
            PostgreSQL cost event {charged.cost_event_id?.slice(0, 8)}… · reservation{' '}
            {charged.reservation_id?.slice(0, 8)}…
          </span>
        ) : null}
      </div>
      {expanded && hasChildren ? (
        <ul>
          {node.children.map((c) => (
            <TreeNode
              key={c.span.span_id}
              node={c}
              depth={depth + 1}
              chargedBySpan={chargedBySpan}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
