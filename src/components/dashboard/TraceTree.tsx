// B2a T1 — trace tree component (D23 flat-indented + collapsible).
// Client component because we toggle expansion locally. Pure presentational:
// takes a flat list of spans + renders a parent→child nested view.

'use client';

import { useMemo, useState } from 'react';
import type { TraceSpan } from '@/lib/clickhouse/dashboard-queries';
import { cn } from '@/lib/utils';

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

export function TraceTree({ spans }: { spans: TraceSpan[] }) {
  const roots = useMemo(() => buildTree(spans), [spans]);
  return (
    <ul className="space-y-0.5 font-mono text-xs">
      {roots.map((node) => (
        <TreeNode key={node.span.span_id} node={node} depth={0} />
      ))}
    </ul>
  );
}

function TreeNode({ node, depth }: { node: Node; depth: number }) {
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  return (
    <li>
      <div className="flex items-baseline gap-2" style={{ paddingLeft: `${depth * 12}px` }}>
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
        <span className="text-[color:var(--muted-foreground)] tabular-nums">
          ${node.span.cost_usd.toFixed(4)} · {node.span.latency_ms} ms
        </span>
      </div>
      {expanded && hasChildren ? (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.span.span_id} node={c} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
