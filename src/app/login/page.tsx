// B2a — /login page (D10 GitHub primary).
// RSC with a small client-component for the magic-link form. Error banners
// reflect ?error=... params set by the OAuth callback / magic verify routes.

import type { Metadata } from 'next';
import { MagicLinkForm } from '@/components/auth/MagicLinkForm';
import { buttonVariants } from '@/components/ui/button';
import { authHrefWithNext, validateAuthNext } from '@/lib/auth/post-auth-redirect';

// /login is Disallow'ed in robots.txt; noindex covers crawlers that reach it
// via an external link anyway (a disallowed URL can still be indexed bare).
export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to Pylva to discover, track, alert on, and bill AI agent costs.',
  robots: { index: false, follow: true },
};

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state_mismatch: 'Session expired. Please try signing in again.',
  oauth_state_invalid: 'Invalid session state. Please try again.',
  oauth_failed: "We couldn't complete sign-in. Please try again.",
  oauth_denied: 'Sign-in was cancelled.',
  magic_expired: 'That magic link has expired. Request a new one.',
  magic_failed: "We couldn't verify that magic link. Try again.",
  magic_missing_token: 'Missing sign-in token.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; next?: string; invite?: string }>;
}) {
  const params = await searchParams;
  const errorCode = params.error ?? '';
  const errorMessage = ERROR_MESSAGES[errorCode];
  const next = validateAuthNext(params.next);

  return (
    <main
      data-marketing
      className="flex min-h-screen items-center justify-center px-4 py-12 font-sans"
    >
      <div className="mkt-card w-full max-w-md p-8">
        <div className="mb-8 flex items-center gap-2 font-semibold">
          <span
            className="inline-flex h-6 w-6 items-center justify-center rounded bg-[color:var(--mkt-fg)] text-[color:var(--mkt-surface)]"
            aria-hidden
          >
            <svg width="14" height="14" viewBox="0 0 13 13" fill="none">
              <path
                d="M2 10.5 5 4.5l2 3 4-6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          Pylva
        </div>
        <h1 className="mkt-display text-3xl font-medium">Sign in to Pylva</h1>
        <p className="mt-2 text-sm" style={{ color: 'var(--mkt-fg-muted)' }}>
          Cost infrastructure for AI agent businesses.
        </p>

        {errorMessage ? (
          <div className="mt-6 rounded-md border border-[color:var(--destructive)] bg-[color:color-mix(in_oklab,var(--destructive)_10%,transparent)] p-3 text-sm">
            {errorMessage}
          </div>
        ) : null}

        {params.invite ? (
          <div className="mt-6 rounded-md border border-[color:var(--mkt-border-strong)] bg-[color:var(--mkt-surface-muted)] p-3 text-sm text-[color:var(--mkt-fg-muted)]">
            You've been invited to an organization. Sign in to accept.
          </div>
        ) : null}

        <div className="mt-8 flex flex-col gap-3">
          <a
            href={authHrefWithNext('/api/v1/auth/oauth/github', next)}
            className={buttonVariants({ className: 'h-11 w-full' })}
          >
            Continue with GitHub
          </a>
          <a
            href={authHrefWithNext('/api/v1/auth/oauth/google', next)}
            className={buttonVariants({ variant: 'outline', className: 'h-11 w-full' })}
          >
            Continue with Google
          </a>
        </div>

        <div className="mt-8">
          <div className="flex items-center gap-3 text-xs uppercase tracking-wider text-[color:var(--mkt-fg-muted)]">
            <div className="h-px flex-1 bg-[color:var(--mkt-border-strong)]" />
            <span>or</span>
            <div className="h-px flex-1 bg-[color:var(--mkt-border-strong)]" />
          </div>
          <MagicLinkForm next={next ?? undefined} />
        </div>

        <p
          data-login-legal
          className="mt-10 text-center text-xs leading-5 text-[color:var(--mkt-fg-muted)]"
        >
          By signing in, you agree to our terms of service. Your data stays in your account; we
          never read prompt or completion text.
        </p>
      </div>
    </main>
  );
}
