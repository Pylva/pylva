// B2a — magic-link email form. Submits to /api/v1/auth/magic/request and
// shows a one-line confirmation on success. Always responds "link sent" to
// avoid leaking whether the email exists.

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';

export function MagicLinkForm({ next }: { next?: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      const res = await fetch('/api/v1/auth/magic/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, ...(next ? { next } : {}) }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Could not send magic link');
        setStatus('error');
        return;
      }
      setStatus('sent');
    } catch {
      setError('Network error — please try again');
      setStatus('error');
    }
  }

  if (status === 'sent') {
    return (
      <p className="mt-4 text-sm text-[color:var(--mkt-fg-muted)]">
        If an account exists for <strong className="text-[color:var(--mkt-fg)]">{email}</strong>, a
        sign-in link is on its way.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-2">
      <label
        htmlFor="magic-email"
        className="text-xs uppercase tracking-wider text-[color:var(--mkt-fg-muted)]"
      >
        Email me a magic link
      </label>
      <div className="flex gap-2">
        <input
          id="magic-email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="min-h-11 flex-1 rounded-md border border-[color:var(--mkt-border-strong)] bg-[color:var(--mkt-surface)] px-3 py-2 text-sm text-[color:var(--mkt-fg)] placeholder:text-[color:var(--mkt-fg-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--mkt-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--mkt-surface)]"
        />
        <Button
          type="submit"
          size="sm"
          disabled={status === 'sending'}
          className="min-h-11 px-4"
        >
          {status === 'sending' ? 'Sending...' : 'Send'}
        </Button>
      </div>
      {error ? <p className="text-xs text-[color:var(--destructive)]">{error}</p> : null}
    </form>
  );
}
