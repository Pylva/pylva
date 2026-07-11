// SPDX-License-Identifier: Elastic-2.0
// Track 4 PR 4.1 — portal config + links management.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation.js';
import { PortalLinkStatus, PortalLinkType, PortalPrimaryColor } from '@pylva/shared';
import { COPY } from '@/lib/copy';
import { apiFetch } from '@/lib/dashboard/api-client';

export interface PortalConfigRow {
  company_name: string | null;
  logo_url: string | null;
  primary_color: string | null;
  cost_display_mode: string;
  show_invoices: boolean;
  show_budget_progress: boolean;
  show_usage_trend: boolean;
  allowed_iframe_origins: string[];
}

export interface PortalLinkRow {
  id: string;
  customer_id: string;
  jti: string;
  link_type: string;
  status: string;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
}

interface Props {
  config: PortalConfigRow | null;
  links: PortalLinkRow[];
  canMutate: boolean;
}

const PALETTE: Array<{ value: string; name: string }> = Object.entries(PortalPrimaryColor).map(
  ([k, v]) => ({ value: v as string, name: k.toLowerCase() }),
);

export function PortalConfigClient({ config, links, canMutate }: Props) {
  const router = useRouter();
  const [companyName, setCompanyName] = useState(config?.company_name ?? '');
  const [logoUrl, setLogoUrl] = useState(config?.logo_url ?? '');
  const [primary, setPrimary] = useState(config?.primary_color ?? PortalPrimaryColor.INDIGO);
  // D7 / migration 036 — invoices are opt-in and default OFF. With no
  // portal_configs row yet (config === null) this MUST default to unchecked;
  // otherwise the first config save silently persists show_invoices=true and
  // exposes builder-confidential billing data to the end-user without the
  // builder ever opting in.
  const [showInvoices, setShowInvoices] = useState(config?.show_invoices ?? false);
  const [originsRaw, setOriginsRaw] = useState((config?.allowed_iframe_origins ?? []).join('\n'));
  const [linkCustomer, setLinkCustomer] = useState('');
  const [linkType, setLinkType] = useState<string>(PortalLinkType.STANDARD);
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function saveConfig() {
    setError(null);
    const origins = originsRaw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (origins.length > 10) {
      setError('Max 10 iframe origins.');
      return;
    }
    const res = await apiFetch('/api/v1/portal/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_name: companyName.trim() || null,
        logo_url: logoUrl.trim() || null,
        primary_color: primary,
        show_invoices: showInvoices,
        allowed_iframe_origins: origins,
      }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Save failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  async function mintLink() {
    setError(null);
    setMintedToken(null);
    if (!linkCustomer.trim()) {
      setError('Customer ID required.');
      return;
    }
    const res = await apiFetch('/api/v1/portal/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_id: linkCustomer.trim(), link_type: linkType }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      setError(data?.error?.message ?? `Mint failed (${res.status})`);
      return;
    }
    setMintedToken(data.link.token);
    setLinkCustomer('');
    startTransition(() => router.refresh());
  }

  async function revokeLink(id: string) {
    setError(null);
    if (!window.confirm('Revoke this portal link? The end-user will lose access immediately.'))
      return;
    const res = await apiFetch(`/api/v1/portal/links/${id}/revoke`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Revoke failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-8">
      {error ? <p className="text-xs text-red-600">{error}</p> : null}

      <section className="rounded-md border border-[color:var(--border)] p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Branding
        </h2>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <label className="text-sm">
            <span>Company name</span>
            <input
              type="text"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              disabled={!canMutate}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm disabled:opacity-50"
            />
          </label>
          <label className="text-sm">
            <span>Logo URL (https only)</span>
            <input
              type="url"
              value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              disabled={!canMutate}
              className="mt-1 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm disabled:opacity-50"
            />
          </label>
        </div>
        <div className="mt-3">
          <span className="text-sm">Primary color</span>
          <div className="mt-1 flex flex-wrap gap-2">
            {PALETTE.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setPrimary(c.value)}
                disabled={!canMutate}
                style={{ backgroundColor: c.value }}
                aria-label={c.name}
                aria-pressed={primary === c.value}
                className={`h-7 w-7 rounded-full border-2 ${
                  primary === c.value ? 'border-black dark:border-white' : 'border-transparent'
                } disabled:opacity-50`}
              />
            ))}
          </div>
          <p className="mt-1 text-xs text-[color:var(--muted-foreground)]">
            {COPY.portal_palette_hint}
          </p>
        </div>
        <label className="mt-3 inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInvoices}
            onChange={(e) => setShowInvoices(e.target.checked)}
            disabled={!canMutate}
          />
          Show invoices to end-users
        </label>
      </section>

      <section className="rounded-md border border-[color:var(--border)] p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Allowed iframe origins (max 10)
        </h2>
        <p className="mt-1 text-xs text-[color:var(--muted-foreground)]">
          {COPY.portal_iframe_hint}
        </p>
        <textarea
          value={originsRaw}
          onChange={(e) => setOriginsRaw(e.target.value)}
          disabled={!canMutate}
          rows={4}
          placeholder={'https://app.example.com\nhttps://customer.example.com'}
          className="mt-2 w-full rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 font-mono text-xs disabled:opacity-50"
        />
      </section>

      {canMutate ? (
        <div>
          <button
            type="button"
            onClick={saveConfig}
            disabled={pending}
            className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
          >
            Save config
          </button>
        </div>
      ) : (
        <p className="text-xs text-[color:var(--muted-foreground)]">
          {COPY.portal_member_view_only}
        </p>
      )}

      <section className="rounded-md border border-[color:var(--border)] p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Portal links
        </h2>

        {canMutate ? (
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              type="text"
              placeholder="Customer UUID"
              value={linkCustomer}
              onChange={(e) => setLinkCustomer(e.target.value)}
              className="min-w-[20rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
            />
            <select
              value={linkType}
              onChange={(e) => setLinkType(e.target.value)}
              className="rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
            >
              <option value={PortalLinkType.STANDARD}>Standard (24h)</option>
              <option value={PortalLinkType.SINGLE_USE}>Single-use</option>
            </select>
            <button
              type="button"
              onClick={mintLink}
              disabled={pending}
              className="rounded-md border border-[color:var(--border)] px-3 py-1 text-sm hover:bg-[color:var(--muted)] disabled:opacity-50"
            >
              Mint link
            </button>
          </div>
        ) : null}

        {mintedToken ? (
          <div className="mt-3 rounded-md border border-emerald-500/40 bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
            <div className="font-semibold">
              Save this link now — the token will not be shown again.
            </div>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-black/80 p-2 text-xs text-emerald-100">
              /portal?token={mintedToken}
            </pre>
            <button
              type="button"
              onClick={() => setMintedToken(null)}
              className="mt-2 text-xs underline"
            >
              I&rsquo;ve saved it
            </button>
          </div>
        ) : null}

        <ul className="mt-4 space-y-2">
          {links.map((l) => (
            <li
              key={l.id}
              className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3 text-sm"
            >
              <div className="min-w-0">
                <div className="truncate font-medium">{l.customer_id}</div>
                <div className="text-xs text-[color:var(--muted-foreground)]">
                  {l.link_type} · {l.status}
                  {' · '}
                  expires {new Date(l.expires_at).toLocaleString()}
                </div>
              </div>
              {canMutate && l.status === PortalLinkStatus.ACTIVE ? (
                <button
                  type="button"
                  onClick={() => revokeLink(l.id)}
                  disabled={pending}
                  className="rounded-md border border-red-500/40 px-3 py-1 text-xs uppercase tracking-wider text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-50"
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
          {links.length === 0 ? (
            <li className="text-xs text-[color:var(--muted-foreground)]">
              No links yet. Mint one for an existing customer to grant portal access.
            </li>
          ) : null}
        </ul>
      </section>
    </div>
  );
}
