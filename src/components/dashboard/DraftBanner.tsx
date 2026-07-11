// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — dashboard banner: "N drafts awaiting review".
//
// Client component — dismiss persists for the tab session (sessionStorage).
// RSC parent passes the count; component hides if count === 0 or dismissed.

'use client';

import { useEffect, useState } from 'react';

interface Props {
  count: number;
  href: string;
}

export function DraftBanner({ count, href }: Props) {
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(sessionStorage.getItem('draftBannerDismissed') === '1');
  }, []);

  if (count === 0 || dismissed) return null;

  const dismiss = () => {
    sessionStorage.setItem('draftBannerDismissed', '1');
    setDismissed(true);
  };

  return (
    <div className="mb-4 flex items-center justify-between rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
      <span>
        <strong>{count}</strong> draft {count === 1 ? 'invoice is' : 'invoices are'} awaiting
        review.{' '}
        <a href={href} className="underline">
          Review
        </a>
        .
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="rounded px-2 py-0.5 text-xs text-[color:var(--muted-foreground)] hover:bg-[color:var(--muted)]"
      >
        Dismiss
      </button>
    </div>
  );
}
