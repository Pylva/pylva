// Track 1 PR 1.3 — webhook settings client component.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation.js';
import { COPY } from '@/lib/copy';
import { apiFetch } from '@/lib/dashboard/api-client';

export interface WebhookRow {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  secret_rotated_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Props {
  webhooks: WebhookRow[];
  canMutate: boolean;
}

const DEFAULT_EVENTS = ['rule.fired', 'margin.alert', 'anomaly.detected'];

export function WebhooksClient({ webhooks, canMutate }: Props) {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [eventsRaw, setEventsRaw] = useState(DEFAULT_EVENTS.join(','));
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function create() {
    setError(null);
    setSecret(null);
    const events = eventsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!url) {
      setError('URL required');
      return;
    }
    if (events.length === 0) {
      setError('At least one event required');
      return;
    }
    const res = await apiFetch('/api/v1/settings/webhooks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, events }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? `Create failed (${res.status})`);
      return;
    }
    setSecret(data.webhook.secret);
    setUrl('');
    startTransition(() => router.refresh());
  }

  async function rotate(id: string) {
    setError(null);
    setSecret(null);
    if (!window.confirm(COPY.webhook_rotate_confirm)) return;
    const res = await apiFetch(`/api/v1/settings/webhooks/${id}/rotate`, { method: 'POST' });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? `Rotate failed (${res.status})`);
      return;
    }
    setSecret(data.webhook.secret);
    startTransition(() => router.refresh());
  }

  async function toggle(id: string, enabled: boolean) {
    setError(null);
    const res = await apiFetch(`/api/v1/settings/webhooks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !enabled }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Update failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function remove(id: string) {
    setError(null);
    if (
      !window.confirm('Delete this webhook? Active rules referencing it will fall through to DLQ.')
    )
      return;
    const res = await apiFetch(`/api/v1/settings/webhooks/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Delete failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      {secret ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
          <div className="font-semibold">
            Save this signing secret now — it will not be shown again.
          </div>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/80 p-2 text-xs text-emerald-100">
            {secret}
          </pre>
          <p className="mt-2 text-xs">{COPY.webhook_grace_window}</p>
          <button type="button" onClick={() => setSecret(null)} className="mt-2 text-xs underline">
            I&rsquo;ve saved it
          </button>
        </div>
      ) : null}

      {canMutate ? (
        <section className="rounded-md border border-[color:var(--border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
            New webhook
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              type="url"
              placeholder="https://hooks.example.com/pylva"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="min-w-[24rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
            />
            <input
              type="text"
              placeholder="rule.fired, margin.alert, ..."
              value={eventsRaw}
              onChange={(e) => setEventsRaw(e.target.value)}
              className="min-w-[24rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={create}
              disabled={pending}
              className="rounded-md bg-[color:var(--primary)] px-3 py-1 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </section>
      ) : (
        <p className="text-xs text-[color:var(--muted-foreground)]">
          {COPY.webhook_member_view_only}
        </p>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Webhooks ({webhooks.length})
        </h2>
        {webhooks.length === 0 ? (
          <p className="mt-2 text-xs text-[color:var(--muted-foreground)]">{COPY.webhook_empty}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {webhooks.map((w) => (
              <li key={w.id} className="rounded-md border border-[color:var(--border)] px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{w.url}</div>
                    <div className="text-xs text-[color:var(--muted-foreground)]">
                      {w.events.join(', ')} · {w.enabled ? 'enabled' : 'disabled'}
                      {w.secret_rotated_at
                        ? ` · rotated ${new Date(w.secret_rotated_at).toLocaleString()}`
                        : ''}
                    </div>
                  </div>
                  {canMutate ? (
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        onClick={() => toggle(w.id, w.enabled)}
                        disabled={pending}
                        className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)] disabled:opacity-50"
                      >
                        {w.enabled ? 'Disable' : 'Enable'}
                      </button>
                      <button
                        type="button"
                        onClick={() => rotate(w.id)}
                        disabled={pending}
                        className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)] disabled:opacity-50"
                      >
                        Rotate secret
                      </button>
                      <button
                        type="button"
                        onClick={() => remove(w.id)}
                        disabled={pending}
                        className="rounded-md border border-red-500/40 px-3 py-1 text-xs uppercase tracking-wider text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
