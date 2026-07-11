// Track 1 PR 1.4 — DLQ list + retry/dismiss actions.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation.js';
import { COPY } from '@/lib/copy';
import { apiFetch } from '@/lib/dashboard/api-client';

export interface DlqRow {
  id: string;
  channel: string;
  event_type: string;
  webhook_config_id: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
}

interface Props {
  entries: DlqRow[];
  canRetry: boolean;
}

export function DlqTable({ entries, canRetry }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function retry(id: string) {
    setError(null);
    const res = await apiFetch(`/api/v1/alerts/dlq/${id}/retry`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (res.status === 404) {
      setError('Entry already handled by another retry.');
      startTransition(() => router.refresh());
      return;
    }
    if (!res.ok) {
      setError(data?.error?.message ?? data?.error ?? `Retry failed (${res.status})`);
      startTransition(() => router.refresh());
      return;
    }
    startTransition(() => router.refresh());
  }

  async function dismiss(id: string) {
    setError(null);
    if (!window.confirm('Dismiss this DLQ entry? It will not be retried.')) return;
    const res = await apiFetch(`/api/v1/alerts/dlq/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Dismiss failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  if (entries.length === 0) {
    return <p className="text-sm text-[color:var(--muted-foreground)]">{COPY.dlq_empty}</p>;
  }

  return (
    <div>
      {error ? <p className="mb-3 text-xs text-red-600">{error}</p> : null}
      <ul className="space-y-2">
        {entries.map((e) => (
          <li key={e.id} className="rounded-md border border-[color:var(--border)] px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">
                  {e.channel} · {e.event_type}{' '}
                  <span className="text-xs text-[color:var(--muted-foreground)]">
                    · {e.attempts} attempt{e.attempts === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="text-xs text-[color:var(--muted-foreground)]">
                  Created {new Date(e.created_at).toLocaleString()}
                  {e.last_attempt_at
                    ? ` · last try ${new Date(e.last_attempt_at).toLocaleString()}`
                    : ''}
                </div>
                {e.last_error ? (
                  <div className="mt-1 truncate text-xs text-red-600">{e.last_error}</div>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                {canRetry ? (
                  <button
                    type="button"
                    onClick={() => retry(e.id)}
                    disabled={pending}
                    className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)] disabled:opacity-50"
                  >
                    Retry
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => dismiss(e.id)}
                  disabled={pending}
                  className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)] disabled:opacity-50"
                >
                  Dismiss
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
