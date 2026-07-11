'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { track } from './events';

// Lightweight PostHog wrapper.
// - Captures `page_viewed` on route changes only — no autocapture, no
//   session replay, no automatic property collection.
// - `surface` ("marketing" | "app") is set by the caller so we can keep
//   instrumentation explicit per internal design notes.
export function PostHogProvider({
  surface,
  children,
}: {
  surface: 'marketing' | 'docs' | 'auth' | 'app';
  children: React.ReactNode;
}) {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    void track('page_viewed', { surface, path: pathname });
  }, [pathname, surface]);

  return <>{children}</>;
}
