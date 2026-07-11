'use client';

import { lazy, Suspense, useState } from 'react';
import { track } from '@/lib/analytics/events';
import { apiFetch } from '@/lib/dashboard/api-client';
import {
  TS_INSTALL,
  PY_INSTALL,
  TS_QUICKSTART,
  PY_QUICKSTART,
} from '@/lib/sdk-snippets';

// Production onboarding for empty workspaces (front-end launch §5).
// 4 steps: create an API key → install SDK → init + send first event →
// view live data. Owners can create the key inline; non-owners see
// read-only guidance. One universal key (migration 048): no scope in the
// POST body — the server always mints a universal key.
//
// Plaintext key is shown exactly once, in the lazy-loaded shared ApiKeyCreatedDialog.
// It is NEVER passed to analytics. Tracked events stay metadata-only.
// After the dialog is dismissed the step renders a persistent completed
// state — re-arming the Create button would read as failure and invite
// duplicate keys.

type Lang = 'ts' | 'py';

const LazyApiKeyCreatedDialog = lazy(() =>
  import('@/components/settings/ApiKeyCreatedDialog').then(({ ApiKeyCreatedDialog }) => ({
    default: ApiKeyCreatedDialog,
  })),
);

export function OnboardingChecklist({ slug, isOwner }: { slug: string; isOwner: boolean }) {
  const [lang, setLang] = useState<Lang>('ts');
  const [creating, setCreating] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [keyCreated, setKeyCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = lang === 'ts' ? TS_INSTALL : PY_INSTALL;
  const quickstart = lang === 'ts' ? TS_QUICKSTART : PY_QUICKSTART;

  async function createKey() {
    if (!isOwner || creating) return;
    setCreating(true);
    setError(null);
    void track('api_key_create_started', { surface: 'app' });
    try {
      const res = await apiFetch(`/api/v1/settings/api-keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Quickstart key' }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(data?.error?.message ?? `Failed to create key (${res.status}). Try again.`);
        return;
      }
      const body = (await res.json()) as {
        key?: { plaintext?: string };
      };
      const plaintext = body.key?.plaintext ?? null;
      if (!plaintext) {
        setError('Key created but plaintext was not returned.');
        return;
      }
      setCreatedKey(plaintext);
      setKeyCreated(true);
      // Tracked WITHOUT the plaintext.
      void track('api_key_created', { surface: 'app', is_owner: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setCreating(false);
    }
  }

  return (
    <section
      className="rounded-md border p-8"
      style={{ borderColor: 'var(--border)' }}
      aria-label="Get started checklist"
    >
      {createdKey !== null ? (
        <Suspense fallback={null}>
          <LazyApiKeyCreatedDialog
            plaintext={createdKey}
            copySurface="onboarding"
            onDone={() => setCreatedKey(null)}
          />
        </Suspense>
      ) : null}

      <h2 className="text-xl font-semibold tracking-tight">Get started</h2>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted-foreground)' }}>
        Send your first cost event to see live data here.
      </p>

      <ol className="mt-6 space-y-6">
        <li>
          <div className="font-medium">1. Create an API key</div>
          {isOwner ? (
            <div className="mt-2">
              {keyCreated ? (
                <div
                  className="rounded-md border p-3 text-sm"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <p>
                    Key created — it&rsquo;s shown only once. Store it as{' '}
                    <code>PYLVA_API_KEY</code>; you can revoke it anytime from{' '}
                    <a
                      href={`/o/${slug}/dashboard/settings/api-keys`}
                      className="underline underline-offset-2"
                    >
                      Settings → API keys
                    </a>
                    .
                  </p>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={createKey}
                  disabled={creating}
                  className="rounded-md px-3 py-1.5 text-sm font-medium"
                  style={{
                    background: 'var(--primary)',
                    color: 'var(--primary-foreground)',
                    opacity: creating ? 0.6 : 1,
                  }}
                >
                  {creating ? 'Creating…' : 'Create API key'}
                </button>
              )}
              {error ? (
                <p role="alert" className="mt-2 text-xs" style={{ color: 'var(--destructive)' }}>
                  {error}
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
              Ask a workspace owner to create an API key. Owners can do this from{' '}
              <a
                href={`/o/${slug}/dashboard/settings/api-keys`}
                className="underline underline-offset-2"
              >
                Settings → API keys
              </a>
              .
            </p>
          )}
        </li>

        <li>
          <div className="font-medium">2. Install the SDK</div>
          <div className="mt-2 flex gap-2 text-xs">
            {(['ts', 'py'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => setLang(l)}
                aria-pressed={lang === l}
                className="rounded px-2 py-1"
                style={{
                  background: lang === l ? 'var(--accent)' : 'transparent',
                  color: 'var(--foreground)',
                  border: '1px solid var(--border)',
                }}
              >
                {l === 'ts' ? 'TypeScript' : 'Python'}
              </button>
            ))}
          </div>
          <pre
            className="mt-2 overflow-x-auto rounded p-3 font-mono text-xs"
            style={{ background: 'var(--muted)' }}
          >
            <code>{install}</code>
          </pre>
        </li>

        <li>
          <div className="font-medium">3. Initialize and send your first event</div>
          <pre
            className="mt-2 overflow-x-auto rounded p-3 font-mono text-xs"
            style={{ background: 'var(--muted)' }}
          >
            <code>{quickstart}</code>
          </pre>
        </li>

        <li>
          <div className="font-medium">4. View live cost data</div>
          <p className="mt-1 text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Once a real event is received, this checklist will yield to your live dashboard
            automatically.
          </p>
        </li>
      </ol>
    </section>
  );
}
