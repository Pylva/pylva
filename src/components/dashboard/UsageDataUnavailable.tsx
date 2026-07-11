'use client';

// Shared fallback card for dashboard pages whose ClickHouse reads failed.
// The dominant trigger is a transient first-request-after-idle failure (cold
// ClickHouse / dropped keep-alive socket) that the failed attempt itself
// warms up — so the card offers a manual Retry and performs one delayed
// auto-retry per failure episode, enough to self-heal without a manual
// browser refresh. The sessionStorage stamp (not just component state) is
// what bounds auto-retries: router.refresh() re-renders this component when
// the query fails again, and a remount must not re-arm the timer.

import { useRouter, usePathname } from 'next/navigation.js';
import { useEffect, useRef, useTransition } from 'react';
import { PageHeader } from '@/components/dashboard/PageHeader';

const AUTO_RETRY_DELAY_MS = 10_000;
const AUTO_RETRY_SUPPRESS_MS = 5 * 60_000;

export function UsageDataUnavailable({ title }: { title: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();
  const autoRetried = useRef(false);

  useEffect(() => {
    const key = `pylva.usage-retry.${pathname ?? 'dashboard'}`;
    let lastAutoRetryAt: number;
    try {
      lastAutoRetryAt = Number(window.sessionStorage.getItem(key) ?? 0);
    } catch {
      // Storage unavailable → NaN fails the comparison below, so we degrade
      // to no auto-retry (no loop risk); manual Retry remains available.
      lastAutoRetryAt = Number.NaN;
    }
    const canAutoRetry = Date.now() - lastAutoRetryAt >= AUTO_RETRY_SUPPRESS_MS;
    if (!canAutoRetry || autoRetried.current) return;

    const timer = window.setTimeout(() => {
      autoRetried.current = true;
      try {
        window.sessionStorage.setItem(key, String(Date.now()));
      } catch {
        // ignore — the ref still prevents re-arming within this mount
      }
      startTransition(() => router.refresh());
    }, AUTO_RETRY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [router, pathname]);

  return (
    <>
      <PageHeader title={title} description="Usage metrics are temporarily unavailable." />
      <div role="status" className="app-card mt-6 max-w-2xl p-6">
        <h2 className="text-sm font-semibold tracking-tight">Usage data unavailable</h2>
        <p className="mt-2 text-sm text-[color:var(--muted-foreground)]">
          Recent cost data could not be loaded. The rest of the dashboard is still available.
        </p>
        <button
          type="button"
          onClick={() => startTransition(() => router.refresh())}
          disabled={isPending}
          className="mt-4 rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm font-medium text-[color:var(--primary-foreground)] disabled:opacity-50"
        >
          {isPending ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    </>
  );
}
