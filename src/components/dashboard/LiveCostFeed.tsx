'use client';

// Live-updating Total Spend / Event Count KPIs. Connects to
// /api/v1/feed/stream via EventSource, increments local counters as
// cost_update messages arrive. EventSource handles network blips with
// built-in 3s reconnect; this component only counts HTTP errors (401/429/500)
// toward a 3-strike fallback (I-SSE-6 / D8). Counter updates batched via
// requestAnimationFrame inside <LiveCounter/> to avoid layout thrash on
// bursty traffic.

import { useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch, orgEventSource } from '@/lib/dashboard/api-client';
import { LiveCounter } from './LiveCounter';
import { Kpi } from './Kpi';
import { formatInt } from '@/lib/formatting';

type FeedStatus = 'connecting' | 'live' | 'reconnecting' | 'fallback';

interface LiveCostFeedProps {
  initialTotalUsd: number;
  initialEventCount: number;
  initialCustomerCount: number;
  endUserLabel: string;
  customerLabelPlural: string;
}

const FALLBACK_FAILURE_THRESHOLD = 3;
// Track 2 PR 2.2 (per O1): once SSE has failed 3 times consecutively,
// poll /api/v1/costs every 30s to keep counters fresh.
const FALLBACK_POLL_INTERVAL_MS = 30_000;
// Bound the seen-customer cache so a long-lived dashboard tab can't grow it
// without limit. Reconnect snapshots reset to authoritative server-truth.
const SEEN_CUSTOMERS_CAP = 10_000;

export function LiveCostFeed(props: LiveCostFeedProps): React.ReactElement {
  const {
    initialTotalUsd,
    initialEventCount,
    initialCustomerCount,
    endUserLabel,
    customerLabelPlural,
  } = props;

  const [totalUsd, setTotalUsd] = useState(initialTotalUsd);
  const [eventCount, setEventCount] = useState(initialEventCount);
  const [customerCount, setCustomerCount] = useState(initialCustomerCount);
  const [status, setStatus] = useState<FeedStatus>('connecting');

  // FIFO-evicting set of customer IDs seen this session. Insertion order is
  // preserved by Map; we track only keys.
  const seenCustomers = useRef<Map<string, true>>(new Map());
  const httpFailureCount = useRef(0);

  useEffect(() => {
    const source = orgEventSource('/api/v1/feed/stream');

    const handleOpen = (): void => {
      httpFailureCount.current = 0;
      setStatus('live');
    };

    const handleSnapshot = (e: MessageEvent<string>): void => {
      try {
        const payload = JSON.parse(e.data) as {
          overview?: {
            total_spend_usd?: number;
            event_count?: number;
            customer_count?: number;
          } | null;
        };
        if (!payload.overview) return;
        if (typeof payload.overview.total_spend_usd === 'number') {
          setTotalUsd(payload.overview.total_spend_usd);
        }
        if (typeof payload.overview.event_count === 'number') {
          setEventCount(payload.overview.event_count);
        }
        if (typeof payload.overview.customer_count === 'number') {
          setCustomerCount(payload.overview.customer_count);
          // Snapshot is authoritative — wipe the local set so post-snapshot
          // dedup reflects current server-truth.
          seenCustomers.current.clear();
        }
      } catch {
        /* ignore malformed snapshot */
      }
    };

    const handleCostUpdate = (e: MessageEvent<string>): void => {
      try {
        const data = JSON.parse(e.data) as { customer_id?: string; cost_usd?: number };
        const cost =
          typeof data.cost_usd === 'number' && Number.isFinite(data.cost_usd) ? data.cost_usd : 0;
        setTotalUsd((prev) => prev + cost);
        setEventCount((prev) => prev + 1);
        if (data.customer_id && !seenCustomers.current.has(data.customer_id)) {
          if (seenCustomers.current.size >= SEEN_CUSTOMERS_CAP) {
            const oldest = seenCustomers.current.keys().next().value;
            if (oldest !== undefined) seenCustomers.current.delete(oldest);
          }
          seenCustomers.current.set(data.customer_id, true);
          setCustomerCount((prev) => prev + 1);
        }
      } catch {
        /* ignore malformed cost_update */
      }
    };

    const handleError = (): void => {
      // EventSource auto-reconnects on network errors (readyState CONNECTING).
      // CLOSED means an HTTP error (401/403/…) tore the connection down for
      // good — the browser never retries a closed source and no further error
      // events fire, so waiting for more strikes would leave the badge stuck
      // on "Reconnecting…" forever. Go straight to polling; if the cause was
      // an account switch, the poll's ORG_MISMATCH handling surfaces it.
      if (source.readyState === EventSource.CLOSED) {
        httpFailureCount.current = FALLBACK_FAILURE_THRESHOLD;
        setStatus('fallback');
        source.close();
        return;
      }
      setStatus('reconnecting');
    };

    source.addEventListener('open', handleOpen);
    source.addEventListener('snapshot', handleSnapshot);
    source.addEventListener('cost_update', handleCostUpdate);
    source.addEventListener('error', handleError);

    return () => {
      source.removeEventListener('open', handleOpen);
      source.removeEventListener('snapshot', handleSnapshot);
      source.removeEventListener('cost_update', handleCostUpdate);
      source.removeEventListener('error', handleError);
      source.close();
    };
  }, []);

  // Track 2 PR 2.2 (O1): when SSE gives up, poll /api/v1/costs at 30s
  // cadence so the dashboard keeps moving without forcing a page reload.
  useEffect(() => {
    if (status !== 'fallback') return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const res = await apiFetch('/api/v1/costs', { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          overview?: { total_spend_usd?: number; event_count?: number; customer_count?: number };
        };
        if (cancelled) return;
        if (typeof data.overview?.total_spend_usd === 'number')
          setTotalUsd(data.overview.total_spend_usd);
        if (typeof data.overview?.event_count === 'number')
          setEventCount(data.overview.event_count);
        if (typeof data.overview?.customer_count === 'number') {
          setCustomerCount(data.overview.customer_count);
          seenCustomers.current.clear();
        }
      } catch {
        /* swallow — next tick will retry */
      }
    };
    void poll();
    const id = setInterval(() => {
      void poll();
    }, FALLBACK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status]);

  const statusBadge = useMemo(() => {
    switch (status) {
      case 'live':
        return { label: 'Live', dotClass: 'bg-emerald-500' };
      case 'connecting':
        return { label: 'Connecting…', dotClass: 'bg-zinc-400' };
      case 'reconnecting':
        return { label: 'Reconnecting…', dotClass: 'bg-amber-500' };
      case 'fallback':
        return { label: 'Polling', dotClass: 'bg-zinc-400' };
    }
  }, [status]);

  return (
    <section className="mt-8">
      <div className="mb-3 flex items-center gap-2 text-xs text-[color:var(--muted-foreground)]">
        <span className={`inline-block h-2 w-2 rounded-full ${statusBadge.dotClass}`} aria-hidden />
        <span>{statusBadge.label}</span>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi label="Total spend">
          <LiveCounter value={totalUsd} format="usd" />
        </Kpi>
        <Kpi label="Events">
          <LiveCounter value={eventCount} format="int" />
        </Kpi>
        <Kpi label={customerLabelPlural}>
          <span aria-label={`${endUserLabel} count`}>{formatInt(customerCount)}</span>
        </Kpi>
      </div>
    </section>
  );
}
