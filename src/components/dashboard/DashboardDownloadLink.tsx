'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/dashboard/api-client';

export function DashboardDownloadLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  const [error, setError] = useState<string | null>(null);

  async function download(event: React.MouseEvent<HTMLAnchorElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await apiFetch(href);
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(body?.error?.message ?? `Export failed (${response.status})`);
      return;
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = 'pylva-export.csv';
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  return (
    <>
      <a href={href} className="underline" onClick={download}>
        {children}
      </a>
      {error ? <span className="ml-2 text-xs text-[color:var(--destructive)]">{error}</span> : null}
    </>
  );
}
