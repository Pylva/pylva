import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { SessionWatcher } from '@/components/dashboard/SessionWatcher';

const COOKIE_NAME = 'pylva_active_session';

function setSessionCookie(value: string): void {
  document.cookie = `${COOKIE_NAME}=${value}`;
}

function clearSessionCookie(): void {
  document.cookie = `${COOKIE_NAME}=; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
}

describe('<SessionWatcher>', () => {
  beforeEach(() => {
    clearSessionCookie();
  });

  afterEach(() => {
    clearSessionCookie();
  });

  it('renders nothing while the cookie matches the expected fingerprint', () => {
    setSessionCookie('abc123.org-a');

    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('shows the switched-account overlay with a link to the new org', () => {
    setSessionCookie('otherfp.org-b');

    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    const overlay = screen.getByRole('alertdialog');
    expect(overlay).toHaveTextContent('This browser switched to a different account');
    expect(screen.getByRole('link', { name: 'Continue to org-b' })).toHaveAttribute(
      'href',
      '/o/org-b/dashboard',
    );
    expect(screen.getByRole('link', { name: 'Sign back in to org-a' })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent('/o/org-a/dashboard')}`,
    );
  });

  it('shows the switched-account overlay when apiFetch reports a session change', () => {
    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent('pylva:session-changed'));
    });

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'This browser switched to a different account',
    );
    expect(screen.getByRole('link', { name: 'Sign back in to org-a' })).toBeInTheDocument();
  });

  it('treats an authoritative org rejection as access loss even when the marker matches', () => {
    setSessionCookie('abc123.org-a');
    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('pylva:session-changed', { detail: { code: 'ORG_MISMATCH' } }),
      );
    });

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Access to this organization changed',
    );

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });

  it('distinguishes a missing page context from an account switch', () => {
    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    act(() => {
      window.dispatchEvent(
        new CustomEvent('pylva:session-changed', {
          detail: { code: 'DASHBOARD_CONTEXT_REQUIRED' },
        }),
      );
    });

    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'This dashboard page needs to be reloaded',
    );
  });

  it('shows the signed-out overlay once an observed cookie disappears', () => {
    setSessionCookie('abc123.org-a');

    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    clearSessionCookie();
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.getByRole('alertdialog')).toHaveTextContent("You've been signed out");
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
      'href',
      `/login?next=${encodeURIComponent('/o/org-a/dashboard')}`,
    );
  });

  it('never alarms on a missing cookie it has not observed (legacy sessions)', () => {
    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('recovers to ok when the expected fingerprint returns to the cookie', () => {
    setSessionCookie('otherfp.org-b');

    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    // Same account signs back in elsewhere — the cookie matches again.
    setSessionCookie('abc123.org-a');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('focuses the dialog and locks body scroll while open, restoring both on recovery', () => {
    setSessionCookie('otherfp.org-b');

    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    const overlay = screen.getByRole('alertdialog');
    expect(document.body.style.overflow).toBe('hidden');
    expect(document.activeElement).not.toBe(document.body);
    expect(overlay.contains(document.activeElement)).toBe(true);

    setSessionCookie('abc123.org-a');
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(document.body.style.overflow).toBe('');
  });

  it('traps Tab inside the dialog in both directions', () => {
    setSessionCookie('otherfp.org-b');

    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    const first = screen.getByRole('link', { name: 'Continue to org-b' });
    const last = screen.getByRole('link', { name: 'Sign back in to org-a' });

    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('wraps reverse Tab from the initially focused dialog to the last action', () => {
    setSessionCookie('otherfp.org-b');
    render(<SessionWatcher expectedFingerprint="abc123" slug="org-a" />);

    const overlay = screen.getByRole('alertdialog');
    const last = screen.getByRole('link', { name: 'Sign back in to org-a' });
    expect(overlay.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });
});
