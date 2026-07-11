// Track 1 PR 1.2 — API key settings client component.
// Owner sees create/revoke surface; member gets read-only metadata.
//
// One universal key (migration 048): the create form carries only an optional
// label. The plaintext is shown exactly once, in a modal with copy actions
// (ApiKeyCreatedDialog); dismissing it clears the plaintext and refreshes the
// list.

'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation.js';
import { COPY } from '@/lib/copy';
import { apiFetch } from '@/lib/dashboard/api-client';
import { ApiKeyCreatedDialog } from '@/components/settings/ApiKeyCreatedDialog';

export interface KeyRow {
  id: string;
  key_id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
}

interface Props {
  keys: KeyRow[];
  canMutate: boolean;
}

export function ApiKeysClient({ keys, canMutate }: Props) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [plaintext, setPlaintext] = useState<string | null>(null);
  // useTransition's pending flag is false while the fetch awaits, so it can't
  // guard against double-clicks minting two keys — track submission locally.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pending, startTransition] = useTransition();

  async function create() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      if (label.trim()) body['label'] = label.trim();
      const res = await apiFetch('/api/v1/settings/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setError(data?.error?.message ?? `Create failed (${res.status})`);
        return;
      }
      const createdPlaintext = data?.key?.plaintext;
      if (!createdPlaintext) {
        setError('Key created but plaintext was not returned.');
        return;
      }
      setPlaintext(createdPlaintext);
      setLabel('');
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleDone() {
    setPlaintext(null);
    startTransition(() => router.refresh());
  }

  async function revoke(id: string) {
    setError(null);
    if (
      !window.confirm('Revoke this key immediately? Active requests using it will start failing.')
    )
      return;
    const res = await apiFetch(`/api/v1/settings/api-keys/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      setError(data?.error?.message ?? `Revoke failed (${res.status})`);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-6">
      <ApiKeyCreatedDialog plaintext={plaintext} copySurface="settings" onDone={handleDone} />

      {canMutate ? (
        <section className="rounded-md border border-[color:var(--border)] p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
            Create key
          </div>
          <div className="mt-3 flex flex-wrap gap-3">
            <input
              type="text"
              placeholder="Label (optional)"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="min-w-[16rem] rounded-md border border-[color:var(--border)] bg-[color:var(--background)] px-2 py-1 text-sm"
            />
            <button
              type="button"
              onClick={create}
              disabled={isSubmitting || pending}
              className="rounded-md bg-[color:var(--primary)] px-3 py-1 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
            >
              {isSubmitting ? 'Creating…' : 'Create API key'}
            </button>
          </div>
          {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
        </section>
      ) : (
        <p className="text-xs text-[color:var(--muted-foreground)]">
          {COPY.api_key_member_view_only}
        </p>
      )}

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-[color:var(--muted-foreground)]">
          Keys ({keys.length})
        </h2>
        {keys.length === 0 ? (
          <p className="mt-2 text-xs text-[color:var(--muted-foreground)]">{COPY.api_key_empty}</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {keys.map((k) => (
              <li
                key={k.id}
                className="flex items-center justify-between rounded-md border border-[color:var(--border)] px-4 py-3"
              >
                <div className="min-w-0">
                  <div className="font-medium">
                    {k.label ?? '(no label)'}{' '}
                    <span className="text-xs text-[color:var(--muted-foreground)]">
                      · {k.key_id}
                    </span>
                  </div>
                  <div className="text-xs text-[color:var(--muted-foreground)]">
                    Created {new Date(k.created_at).toLocaleDateString()}
                    {k.revoked_at
                      ? ` · revoked ${new Date(k.revoked_at).toLocaleDateString()}`
                      : ''}
                    {k.expires_at && !k.revoked_at
                      ? ` · expires ${new Date(k.expires_at).toLocaleDateString()}`
                      : ''}
                  </div>
                </div>
                {canMutate && !k.revoked_at ? (
                  <button
                    type="button"
                    onClick={() => revoke(k.id)}
                    disabled={pending}
                    className="rounded-md border border-[color:var(--border)] px-3 py-1 text-xs uppercase tracking-wider hover:bg-[color:var(--muted)] disabled:opacity-50"
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
