// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — builder-level alert config form. Renders the channel selector
// + channel-specific fields. Saves to PUT/POST /api/v1/billing/alert-config.
//
// Client component because: form state + optimistic UI. The server-rendered
// parent page passes the loaded row; this component takes over on mount.

'use client';

import { useState } from 'react';
import { AlertDeliveryChannel, type AlertDeliveryChannel as Channel } from '@pylva/shared';
import { apiFetch } from '@/lib/dashboard/api-client';

interface InitialConfig {
  channel: string | null;
  enabled: boolean;
  webhook_config_id: string | null;
  email_recipients: string[] | null;
  slack_webhook_url: string | null;
}

interface Props {
  initial: InitialConfig | null;
  disabled: boolean;
}

export function BuilderAlertConfigForm({ initial, disabled }: Props) {
  const [channel, setChannel] = useState<Channel>(
    (initial?.channel as Channel | null) ?? AlertDeliveryChannel.EMAIL,
  );
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [webhookConfigId, setWebhookConfigId] = useState(initial?.webhook_config_id ?? '');
  const [emailRecipients, setEmailRecipients] = useState(
    (initial?.email_recipients ?? []).join(', '),
  );
  const [slackWebhookUrl, setSlackWebhookUrl] = useState(initial?.slack_webhook_url ?? '');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('saving');
    setError(null);
    const body: Record<string, unknown> = { channel, enabled };
    if (channel === AlertDeliveryChannel.WEBHOOK) body['webhook_config_id'] = webhookConfigId;
    if (channel === AlertDeliveryChannel.EMAIL) {
      body['email_recipients'] = emailRecipients
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
    if (channel === AlertDeliveryChannel.SLACK) body['slack_webhook_url'] = slackWebhookUrl;

    try {
      const res = await apiFetch('/api/v1/billing/alert-config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
      }
      setStatus('saved');
    } catch (err) {
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          disabled={disabled}
        />
        Enabled
      </label>

      <label className="flex flex-col gap-1 text-sm">
        Channel
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value as Channel)}
          disabled={disabled}
          className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
        >
          <option value={AlertDeliveryChannel.EMAIL}>Email</option>
          <option value={AlertDeliveryChannel.WEBHOOK}>Webhook</option>
          <option value={AlertDeliveryChannel.SLACK}>Slack</option>
        </select>
      </label>

      {channel === AlertDeliveryChannel.EMAIL ? (
        <label className="flex flex-col gap-1 text-sm">
          Recipients (comma-separated)
          <input
            type="text"
            value={emailRecipients}
            onChange={(e) => setEmailRecipients(e.target.value)}
            disabled={disabled}
            placeholder="ops@example.com, finance@example.com"
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
          />
        </label>
      ) : null}

      {channel === AlertDeliveryChannel.WEBHOOK ? (
        <label className="flex flex-col gap-1 text-sm">
          Webhook config id
          <input
            type="text"
            value={webhookConfigId}
            onChange={(e) => setWebhookConfigId(e.target.value)}
            disabled={disabled}
            placeholder="Use an existing webhook config id from settings/webhooks"
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
          />
        </label>
      ) : null}

      {channel === AlertDeliveryChannel.SLACK ? (
        <label className="flex flex-col gap-1 text-sm">
          Slack webhook URL
          <input
            type="url"
            value={slackWebhookUrl}
            onChange={(e) => setSlackWebhookUrl(e.target.value)}
            disabled={disabled}
            placeholder="https://hooks.slack.com/services/..."
            className="rounded-md border border-[color:var(--border)] bg-transparent px-2 py-1.5"
          />
        </label>
      ) : null}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={disabled || status === 'saving'}
          className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
        >
          {status === 'saving' ? 'Saving…' : 'Save'}
        </button>
        {status === 'saved' ? <span className="text-xs text-green-600">Saved.</span> : null}
        {status === 'error' && error ? <span className="text-xs text-red-600">{error}</span> : null}
      </div>
    </form>
  );
}
