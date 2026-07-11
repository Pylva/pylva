'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/dashboard/api-client';

interface DashboardActionButtonProps {
  endpoint: string;
  label: string;
  disabled?: boolean;
  body?: Record<string, unknown>;
  redirectField?: string;
  className: string;
}

export function DashboardActionButton({
  endpoint,
  label,
  disabled = false,
  body,
  redirectField,
  className,
}: DashboardActionButtonProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const response = await apiFetch(endpoint, {
        method: 'POST',
        ...(body
          ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      if (!response.ok) {
        const apiError = payload?.['error'] as { message?: string } | undefined;
        setError(apiError?.message ?? `Request failed (${response.status})`);
        return;
      }
      const destination = redirectField ? payload?.[redirectField] : null;
      if (typeof destination === 'string') {
        window.location.assign(destination);
        return;
      }
      router.refresh();
    } catch {
      setError('Request failed — try again');
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button type="button" disabled={disabled || pending} className={className} onClick={run}>
        {pending ? 'Working…' : label}
      </button>
      {error ? <p className="mt-2 text-xs text-[color:var(--destructive)]">{error}</p> : null}
    </div>
  );
}
