// v2 — audit-log viewer (O13).

'use client';

import { useCallback, useEffect, useState } from 'react';
import { COPY } from '@/lib/copy';
import { apiFetch } from '@/lib/dashboard/api-client';
import { AuditAction } from '@/lib/audit/actions';

export interface AuditEntry {
  id: number;
  actor_type: string;
  actor_id: string;
  actor_user_id: string | null;
  actor_email: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  timestamp: string;
}

const ACTION_OPTIONS = Object.values(AuditAction).sort();

export function AuditLogClient() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // Filters
  const [action, setAction] = useState<string>('');
  const [resourceType, setResourceType] = useState<string>('');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');

  const buildUrl = useCallback(
    (cursor: string | null) => {
      const u = new URL('/api/v1/audit-log', window.location.origin);
      if (action) u.searchParams.set('action', action);
      if (resourceType) u.searchParams.set('resource_type', resourceType);
      if (from) u.searchParams.set('from', new Date(from).toISOString());
      if (to) u.searchParams.set('to', new Date(to).toISOString());
      if (cursor) u.searchParams.set('cursor', cursor);
      return u.toString();
    },
    [action, resourceType, from, to],
  );

  const load = useCallback(
    async (cursor: string | null) => {
      setLoading(true);
      setError(null);
      try {
        const res = await apiFetch(buildUrl(cursor), { credentials: 'include' });
        const data = await res.json();
        if (!res.ok) {
          setError(data?.error?.message ?? `Load failed (${res.status})`);
          return;
        }
        setEntries((prev) => (cursor ? [...prev, ...data.entries] : data.entries));
        setNextCursor(data.next_cursor ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Load failed');
      } finally {
        setLoading(false);
      }
    },
    [buildUrl],
  );

  // Reload from page 1 whenever filters change.
  useEffect(() => {
    setEntries([]);
    setExpanded(new Set());
    void load(null);
  }, [load]);

  function toggleExpand(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap gap-3 rounded-md border border-[color:var(--border)] p-3">
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
        >
          <option value="">All actions</option>
          {ACTION_OPTIONS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          type="text"
          placeholder="Resource type (e.g. rule, webhook_config)"
          value={resourceType}
          onChange={(e) => setResourceType(e.target.value)}
          className="min-w-[16rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
        />
        <input
          type="datetime-local"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
          aria-label="From"
        />
        <input
          type="datetime-local"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
          aria-label="To"
        />
        {action || resourceType || from || to ? (
          <button
            type="button"
            onClick={() => {
              setAction('');
              setResourceType('');
              setFrom('');
              setTo('');
            }}
            className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)]"
          >
            Clear
          </button>
        ) : null}
      </section>

      {error ? <p className="text-xs text-red-600">{error}</p> : null}

      {entries.length === 0 && !loading ? (
        <p className="text-xs text-[color:var(--muted-foreground)]">{COPY.audit_log_empty}</p>
      ) : null}

      <ul className="space-y-2">
        {entries.map((e) => {
          const open = expanded.has(e.id);
          const actorLabel =
            e.actor_email ??
            (e.actor_type === 'system'
              ? `system: ${e.actor_id}`
              : `${e.actor_type}: ${e.actor_id}`);
          return (
            <li
              key={e.id}
              className="rounded-md border border-[color:var(--border)] px-4 py-3 text-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-medium">
                    <span className="font-mono text-xs">{e.action}</span>
                    {' · '}
                    <span className="text-xs text-[color:var(--muted-foreground)]">
                      {e.resource_type}
                      {e.resource_id ? `:${e.resource_id.slice(0, 12)}…` : ''}
                    </span>
                  </div>
                  <div className="text-xs text-[color:var(--muted-foreground)]">
                    {new Date(e.timestamp).toLocaleString()} · {actorLabel}
                    {e.ip_address ? ` · ${e.ip_address}` : ''}
                  </div>
                </div>
                {e.details ? (
                  <button
                    type="button"
                    onClick={() => toggleExpand(e.id)}
                    className="shrink-0 rounded-md border border-[color:var(--border)] px-2 py-0.5 text-xs hover:bg-[color:var(--muted)]"
                    aria-expanded={open}
                  >
                    {open ? 'Hide' : 'Details'}
                  </button>
                ) : null}
              </div>
              {open && e.details ? (
                <pre className="mt-2 overflow-x-auto rounded bg-[color:var(--muted)] p-2 text-xs">
                  {JSON.stringify(e.details, null, 2)}
                </pre>
              ) : null}
            </li>
          );
        })}
      </ul>

      {nextCursor ? (
        <button
          type="button"
          onClick={() => void load(nextCursor)}
          disabled={loading}
          className="rounded-md border border-[color:var(--border)] px-3 py-1 text-sm hover:bg-[color:var(--muted)] disabled:opacity-50"
        >
          {loading ? 'Loading…' : 'Load more'}
        </button>
      ) : null}
    </div>
  );
}
