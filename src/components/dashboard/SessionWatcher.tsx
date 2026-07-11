'use client';

// Detects the browser's single session slot changing hands underneath an
// open dashboard tab (login as a DIFFERENT account, or logout, in another
// tab) and blocks the stale page with an explanatory overlay instead of
// letting it 404 or show the other account's data. A same-user org switch is
// deliberately NOT flagged: the fingerprint compares userId only, because
// org-bound API scoping (x-pylva-org) keeps a multi-org user's other-org
// tabs fully functional. The overlay clears itself if the matching session
// returns (e.g. the user signs back in as the same account).
//
// Detection sources, cheapest first:
//  - the JS-readable pylva_active_session cookie (fingerprint.slug — see
//    session-fingerprint.ts) compared against the fingerprint this page was
//    server-rendered for, checked on focus/visibility/interval;
//  - a BroadcastChannel ping sent by freshly-signed-in tabs;
//  - SESSION_CHANGED_EVENT fired by apiFetch on a 403 ORG_MISMATCH.
//
// A missing cookie only alarms after it has been observed present (legacy
// sessions predating the cookie must not trip the overlay).

import { useCallback, useEffect, useRef, useState } from 'react';
import { SESSION_CHANGED_EVENT, type SessionChangedDetail } from '@/lib/dashboard/api-client';

const COOKIE_NAME = 'pylva_active_session';
const CHANNEL_NAME = 'pylva-session';
const CHECK_INTERVAL_MS = 10_000;
// Keep the root dashboard layout off the CVA/tailwind-merge client chunk.
// These retain the primitive's layout, palette, and keyboard focus treatment.
const ACTION_BASE_CLASSES =
  'inline-flex h-9 w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]';
const PRIMARY_ACTION_CLASSES = `${ACTION_BASE_CLASSES} bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90`;
const OUTLINE_ACTION_CLASSES = `${ACTION_BASE_CLASSES} border bg-[var(--background)] text-[var(--foreground)] hover:bg-[var(--accent)] hover:text-[var(--accent-foreground)]`;

type SessionState =
  | { kind: 'ok' }
  | { kind: 'switched'; newSlug: string | null }
  | { kind: 'signed-out' }
  | { kind: 'access-lost' }
  | { kind: 'stale-context' };

function readActiveSessionCookie(): { fingerprint: string; slug: string } | null {
  const entry = document.cookie.split('; ').find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!entry) return null;
  const value = decodeURIComponent(entry.slice(COOKIE_NAME.length + 1));
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  return { fingerprint: value.slice(0, dot), slug: value.slice(dot + 1) };
}

export function SessionWatcher({
  expectedFingerprint,
  slug,
}: {
  expectedFingerprint: string;
  slug: string;
}) {
  const [state, setState] = useState<SessionState>({ kind: 'ok' });
  const sawCookieRef = useRef(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const authoritativeBlockRef = useRef(false);

  // The overlay's job is to BLOCK the stale tab: move focus into the dialog,
  // keep Tab cycling inside it (background actions would otherwise still be
  // keyboard-reachable and would execute under the new session), and lock
  // background scroll while it is up.
  useEffect(() => {
    if (state.kind === 'ok') return;
    dialogRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [state.kind]);

  const trapTab = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== 'Tab') return;
    const focusable = overlayRef.current?.querySelectorAll<HTMLElement>('a[href], button');
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (
      event.shiftKey &&
      (document.activeElement === first || document.activeElement === dialogRef.current)
    ) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  const check = useCallback(() => {
    if (authoritativeBlockRef.current) return;
    const cookie = readActiveSessionCookie();
    if (!cookie) {
      if (sawCookieRef.current) {
        setState((prev) => (prev.kind === 'signed-out' ? prev : { kind: 'signed-out' }));
      }
      return;
    }
    sawCookieRef.current = true;
    if (cookie.fingerprint !== expectedFingerprint) {
      const newSlug = cookie.slug || null;
      setState((prev) =>
        prev.kind === 'switched' && prev.newSlug === newSlug ? prev : { kind: 'switched', newSlug },
      );
    } else {
      // Session matches again (same account signed back in) — unblock.
      setState((prev) => (prev.kind === 'ok' ? prev : { kind: 'ok' }));
    }
  }, [expectedFingerprint]);

  useEffect(() => {
    check();

    const onSessionChanged = (event: Event) => {
      authoritativeBlockRef.current = true;
      const code = (event as CustomEvent<SessionChangedDetail>).detail?.code;
      if (code === 'ORG_MISMATCH') {
        setState({ kind: 'access-lost' });
        return;
      }
      if (code === 'DASHBOARD_CONTEXT_REQUIRED') {
        setState({ kind: 'stale-context' });
        return;
      }
      const cookie = readActiveSessionCookie();
      setState({ kind: 'switched', newSlug: cookie?.slug ?? null });
    };
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', check);
    window.addEventListener(SESSION_CHANGED_EVENT, onSessionChanged);

    // Nudge other tabs to re-check immediately when this page (freshly
    // authenticated) mounts; react to their nudges the same way.
    let channel: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = check;
      channel.postMessage({ fingerprint: expectedFingerprint });
    }

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener(SESSION_CHANGED_EVENT, onSessionChanged);
      channel?.close();
    };
  }, [check, expectedFingerprint]);

  if (state.kind === 'ok') return null;

  const signInHref = `/login?next=${encodeURIComponent(`/o/${slug}/dashboard`)}`;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-watcher-title"
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4"
      ref={overlayRef}
      onKeyDown={trapTab}
    >
      <div
        tabIndex={-1}
        ref={dialogRef}
        className="w-full max-w-md rounded-lg border bg-[var(--background)] p-6 shadow-lg outline-none"
      >
        {state.kind === 'switched' ? (
          <>
            <h2 id="session-watcher-title" className="text-lg font-semibold tracking-tight">
              This browser switched to a different account
            </h2>
            <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
              A sign-in elsewhere in this browser replaced the session this page was using, so{' '}
              <span className="font-medium">{slug}</span> is no longer accessible from this tab.
              Pylva supports one signed-in account per browser — use separate browser profiles to
              work in two accounts at once.
            </p>
            <div className="mt-5 flex flex-col gap-2">
              {state.newSlug ? (
                <a href={`/o/${state.newSlug}/dashboard`} className={PRIMARY_ACTION_CLASSES}>
                  Continue to {state.newSlug}
                </a>
              ) : null}
              <a
                href={signInHref}
                className={state.newSlug ? OUTLINE_ACTION_CLASSES : PRIMARY_ACTION_CLASSES}
              >
                Sign back in to {slug}
              </a>
            </div>
          </>
        ) : state.kind === 'signed-out' ? (
          <>
            <h2 id="session-watcher-title" className="text-lg font-semibold tracking-tight">
              You&apos;ve been signed out
            </h2>
            <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
              This browser&apos;s Pylva session ended (signed out in another tab), so this page can
              no longer load {slug}&apos;s data.
            </p>
            <div className="mt-5">
              <a href={signInHref} className={PRIMARY_ACTION_CLASSES}>
                Sign in
              </a>
            </div>
          </>
        ) : (
          <>
            <h2 id="session-watcher-title" className="text-lg font-semibold tracking-tight">
              {state.kind === 'access-lost'
                ? 'Access to this organization changed'
                : 'This dashboard page needs to be reloaded'}
            </h2>
            <p className="mt-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
              {state.kind === 'access-lost'
                ? `Your active session no longer has access to ${slug}.`
                : 'The page was opened before the current session-safety checks were available.'}
            </p>
            <div className="mt-5">
              <a href={`/o/${slug}/dashboard`} className={PRIMARY_ACTION_CLASSES}>
                Reload dashboard
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
