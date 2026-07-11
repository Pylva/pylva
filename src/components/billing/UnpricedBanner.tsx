// SPDX-License-Identifier: Elastic-2.0
// Loud, actionable banner for invoices that EXCLUDE unpriced usage (I-T2-5):
// usage whose metric has no price yet is left off the bill, so the builder may
// be under-charging their customer. Non-dismissible by design — hiding an
// under-billing warning would defeat the purpose. The caller supplies the copy
// (single-invoice vs list-count) so the styling is shared but the message fits.
//
// Warning palette matches the existing billing banners (yellow-500). The app
// warning token is not used app-wide yet, so this stays consistent with DraftBanner.
import type { ReactNode } from 'react';

export function UnpricedBanner({ href, children }: { href: string; children: ReactNode }) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between gap-3 rounded-md border border-yellow-500/40 bg-yellow-500/10 p-3 text-sm"
    >
      <p>
        <span aria-hidden className="mr-1">
          ⚠️
        </span>
        {children}
      </p>
      <a
        href={href}
        className="shrink-0 rounded-md border border-yellow-500/40 px-3 py-1 text-xs font-medium hover:bg-yellow-500/15"
      >
        Price metrics →
      </a>
    </div>
  );
}
