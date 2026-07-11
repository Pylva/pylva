'use client';

import { useEffect } from 'react';

// Launch robustness — root error boundary. Replaces the entire document
// when the root layout itself throws, so tokens/styles may be unavailable:
// inline styles only. Still reports to Sentry (production gate, #209).

export default function GlobalError({
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

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: 'system-ui, sans-serif',
          display: 'grid',
          placeItems: 'center',
          minHeight: '100vh',
          margin: 0,
        }}
      >
        {/* Replaces the whole document, so the layout's <title> is gone;
            React hoists this one into <head>. */}
        <title>Something went wrong — Pylva</title>
        <div style={{ textAlign: 'center', padding: 24 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600 }}>Something went wrong</h1>
          <p style={{ color: '#555', fontSize: 14 }}>
            An unexpected error occurred{error.digest ? ` (ref ${error.digest})` : ''}.
          </p>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: 16,
              padding: '8px 16px',
              borderRadius: 6,
              border: '1px solid #ccc',
              background: '#111',
              color: '#fff',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
