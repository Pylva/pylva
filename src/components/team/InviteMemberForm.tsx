// B2a T1 — invite-member form (Owner-only on the backend; UI hides for members).

'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/dashboard/api-client';

export function InviteMemberForm() {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'owner' | 'member'>('member');
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setStatus('sending');
    setError(null);
    try {
      const res = await apiFetch('/api/v1/invites/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, role }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setError(body?.error?.message ?? 'Invite failed');
        setStatus('error');
        return;
      }
      setStatus('sent');
      setEmail('');
      // Hard-refresh to re-render the pending-invites list.
      window.location.reload();
    } catch {
      setError('Network error');
      setStatus('error');
    }
  }

  return (
    <form onSubmit={onSubmit} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <label
          htmlFor="invite-email"
          className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]"
        >
          Email
        </label>
        <input
          id="invite-email"
          type="email"
          required
          autoComplete="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1 block w-full rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
        />
      </div>
      <div>
        <label
          htmlFor="invite-role"
          className="text-xs uppercase tracking-wider text-[color:var(--muted-foreground)]"
        >
          Role
        </label>
        <select
          id="invite-role"
          value={role}
          onChange={(e) => setRole(e.target.value as 'owner' | 'member')}
          className="mt-1 block rounded-md border border-[color:var(--input)] bg-[color:var(--background)] px-3 py-1.5 text-sm"
        >
          <option value="member">Member</option>
          <option value="owner">Owner</option>
        </select>
      </div>
      <Button type="submit" disabled={status === 'sending'}>
        {status === 'sending' ? 'Sending…' : 'Send invite'}
      </Button>
      {status === 'sent' ? (
        <p className="text-xs text-[color:var(--muted-foreground)]">Invite sent.</p>
      ) : null}
      {error ? <p className="text-xs text-[color:var(--destructive)]">{error}</p> : null}
    </form>
  );
}
