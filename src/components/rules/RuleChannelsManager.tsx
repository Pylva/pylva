// Track 1 PR 1.1 — channel CRUD UI on the rule detail page.
// Owner-only mutation surface; members see read-only list + a member banner.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation.js';
import { apiFetch } from '@/lib/dashboard/api-client';
import { COPY } from '@/lib/copy';

type ChannelKind = 'webhook' | 'email' | 'slack';

export interface ChannelRow {
  id: string;
  channel: ChannelKind;
  enabled: boolean;
  webhook_config_id: string | null;
  email_recipients: string[] | null;
  slack_webhook_url: string | null;
}

export interface WebhookOption {
  id: string;
  url: string;
  enabled: boolean;
}

interface Props {
  ruleId: string;
  channels: ChannelRow[];
  webhookOptions: WebhookOption[];
  canMutate: boolean;
}

export function RuleChannelsManager({ ruleId, channels, webhookOptions, canMutate }: Props) {
  const router = useRouter();
  const [kind, setKind] = useState<ChannelKind>('webhook');
  const [webhookId, setWebhookId] = useState<string>(webhookOptions[0]?.id ?? '');
  const [emailRaw, setEmailRaw] = useState('');
  const [slackUrl, setSlackUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function add() {
    setError(null);
    const body: Record<string, unknown> = { channel: kind };
    if (kind === 'webhook') {
      if (!webhookId) {
        setError(COPY.channel_no_webhooks);
        return;
      }
      body['webhook_config_id'] = webhookId;
    } else if (kind === 'email') {
      const recipients = emailRaw
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (recipients.length === 0) {
        setError('At least one email required');
        return;
      }
      body['email_recipients'] = recipients;
    } else {
      if (!slackUrl) {
        setError('Slack webhook URL required');
        return;
      }
      body['slack_webhook_url'] = slackUrl;
    }
    const res = await apiFetch(`/api/v1/rules/${ruleId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Add failed (${res.status})`);
      return;
    }
    setEmailRaw('');
    setSlackUrl('');
    startTransition(() => router.refresh());
  }

  async function remove(channelId: string) {
    setError(null);
    const res = await apiFetch(`/api/v1/rules/${ruleId}/channels/${channelId}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Remove failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
        Alert channels ({channels.length})
      </h2>

      {channels.length === 0 ? (
        <p className="mt-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
          {COPY.channel_empty_warning}
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {channels.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3"
            >
              <div className="min-w-0">
                <div className="font-medium">{labelFor(c.channel)}</div>
                <div className="truncate text-xs text-[color:var(--muted-foreground)]">
                  {summaryFor(c, webhookOptions)}
                </div>
              </div>
              {canMutate ? (
                <button
                  type="button"
                  onClick={() => remove(c.id)}
                  disabled={pending}
                  className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)] disabled:opacity-50"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canMutate ? (
        <div className="mt-4 rounded-md border border-[color:var(--border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
            Add channel
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as ChannelKind)}
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
            >
              <option value="webhook">{COPY.channel_webhook}</option>
              <option value="email">{COPY.channel_email}</option>
              <option value="slack">{COPY.channel_slack}</option>
            </select>

            {kind === 'webhook' ? (
              webhookOptions.length === 0 ? (
                <span className="text-xs text-[color:var(--muted-foreground)]">
                  {COPY.channel_no_webhooks}
                </span>
              ) : (
                <select
                  value={webhookId}
                  onChange={(e) => setWebhookId(e.target.value)}
                  className="min-w-[20rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
                >
                  {webhookOptions.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.url}
                      {w.enabled ? '' : ' (disabled)'}
                    </option>
                  ))}
                </select>
              )
            ) : null}

            {kind === 'email' ? (
              <input
                type="text"
                placeholder="alice@example.com, bob@example.com"
                value={emailRaw}
                onChange={(e) => setEmailRaw(e.target.value)}
                className="min-w-[20rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
              />
            ) : null}

            {kind === 'slack' ? (
              <input
                type="url"
                placeholder="https://hooks.slack.com/services/..."
                value={slackUrl}
                onChange={(e) => setSlackUrl(e.target.value)}
                className="min-w-[20rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
              />
            ) : null}

            <button
              type="button"
              onClick={add}
              disabled={pending}
              className="rounded-md bg-[color:var(--primary)] px-3 py-1 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
            >
              Add
            </button>
          </div>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </div>
      ) : (
        <p className="mt-3 text-xs text-[color:var(--muted-foreground)]">
          {COPY.channel_member_view_only}
        </p>
      )}
    </section>
  );
}

function labelFor(kind: ChannelKind): string {
  if (kind === 'webhook') return COPY.channel_webhook;
  if (kind === 'email') return COPY.channel_email;
  return COPY.channel_slack;
}

function summaryFor(c: ChannelRow, webhooks: WebhookOption[]): string {
  if (c.channel === 'webhook') {
    const w = webhooks.find((x) => x.id === c.webhook_config_id);
    return w ? w.url : (c.webhook_config_id ?? '(deleted webhook config)');
  }
  if (c.channel === 'email') return (c.email_recipients ?? []).join(', ') || '(no recipients)';
  return c.slack_webhook_url ?? '(no url)';
}
