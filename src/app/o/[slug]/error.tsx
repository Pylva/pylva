'use client';

// Launch robustness — dashboard error boundary. Catches render/data errors
// from any /o/{slug}/* page so users get a retry affordance instead of a
// blank page. Renders inside the app shell (boundary sits below the slug
// layout per Next segment ordering).

import { usePathname } from 'next/navigation.js';
import { useEffect } from 'react';

export default function OrgError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    void import('@sentry/nextjs')
      .then(({ captureException }) => captureException(error))
      .catch(() => {});
  }, [error]);
  const pathname = usePathname();
  const slug = /^\/o\/([^/]+)\//.exec(pathname ?? '')?.[1];
  return (
    <div role="alert" className="app-card mx-auto mt-16 max-w-md p-8 text-center">
      <h1 className="text-lg font-semibold tracking-tight">Something went wrong</h1>
      <p className="mt-2 text-sm app-muted">
        The page hit an unexpected error. Retry, or head back to the overview.
        {error.digest ? ` (ref ${error.digest})` : null}
      </p>
      <div className="mt-6 flex items-center justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm font-medium text-[color:var(--primary-foreground)]"
        >
          Try again
        </button>
        {slug ? (
          <a
            href={`/o/${slug}/dashboard`}
            className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm font-medium"
          >
            Go to overview
          </a>
        ) : null}
      </div>
    </div>
  );
}
