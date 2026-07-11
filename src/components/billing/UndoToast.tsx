// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — post-save undo toast. 10-second window (I-T2-12). After the
// window expires, the button 410s and we self-dismiss.

'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/dashboard/api-client';

interface Props {
  customerId: string;
  onDismiss: () => void;
}

const UNDO_SECONDS = 10;

export function UndoToast({ customerId, onDismiss }: Props) {
  const [remaining, setRemaining] = useState(UNDO_SECONDS);
  const [status, setStatus] = useState<'idle' | 'undoing' | 'undone' | 'expired'>('idle');

  useEffect(() => {
    if (remaining <= 0) {
      setStatus('expired');
      return;
    }
    const t = setTimeout(() => setRemaining((r) => r - 1), 1000);
    return () => clearTimeout(t);
  }, [remaining]);

  async function undo() {
    setStatus('undoing');
    try {
      const res = await apiFetch(`/api/v1/customers/${customerId}/pricing/undo-last`, {
        method: 'POST',
      });
      if (!res.ok) {
        setStatus('expired');
        return;
      }
      setStatus('undone');
      setTimeout(onDismiss, 1500);
    } catch {
      setStatus('expired');
    }
  }

  return (
    <div className="fixed bottom-6 right-6 flex items-center gap-3 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] px-4 py-3 shadow-lg text-sm">
      <span>{status === 'undone' ? 'Reverted.' : 'Pricing updated.'}</span>
      {status !== 'undone' && remaining > 0 ? (
        <button
          type="button"
          onClick={undo}
          disabled={status === 'undoing'}
          className="rounded-md border border-[color:var(--border)] px-2 py-1 text-xs hover:bg-[color:var(--accent)]"
        >
          Undo ({remaining}s)
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        className="text-xs text-[color:var(--muted-foreground)] hover:underline"
      >
        Dismiss
      </button>
    </div>
  );
}
