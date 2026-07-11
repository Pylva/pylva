// Dashboard shell — Sidebar nav + header + content slot.
// Lives at the [slug] segment so dashboard children share Sidebar/TopBar.

import { Suspense } from 'react';
import type { Metadata } from 'next';
import { Sidebar } from '@/components/dashboard/Sidebar';
import { TopBar } from '@/components/dashboard/TopBar';
import { BrokenSourcesBanner } from '@/components/dashboard/BrokenSourcesBanner';
import { SessionWatcher } from '@/components/dashboard/SessionWatcher';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { sessionFingerprint } from '@/lib/auth/session-fingerprint';
import { PageViewBeacon } from '@/lib/analytics/page-view-beacon';
import { PAGE_SESSION_META_NAME } from '@/lib/dashboard/request-context';

const themeScript = `(function(){try{var stored=localStorage.getItem("pylva:theme"),system=matchMedia("(prefers-color-scheme: dark)").matches,dark=stored==="dark"||((!stored||stored==="system")&&system);document.documentElement.classList.toggle("dark",dark)}catch(e){}})();`;

// Authenticated tenant surface: middleware already redirects anonymous
// requests, and robots.txt disallows /o/; noindex is defense in depth.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function DashboardLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { builderId, userId, pathname } = await readDashboardHeaders();
  const pageSession = sessionFingerprint(userId);
  return (
    <>
      <meta name={PAGE_SESSION_META_NAME} content={pageSession} />
      <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      <PageViewBeacon surface="app" />
      {/* Blocks this tab with an overlay if the browser's session switches to
          another account (login/logout in a different tab). */}
      <SessionWatcher expectedFingerprint={pageSession} slug={slug} />
      <div data-app className="flex min-h-screen">
        <Sidebar pathname={pathname} slug={slug} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar />
          <main className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
            {/* Track 2 PR 2.5 (O39): persistent banner whenever any cost_source
                has status='broken'. Builder alert channel delivery handled by
                the hourly health-check cron + builder-alert helper. Suspense
                keeps its RLS query off the first-paint critical path. */}
            <Suspense fallback={null}>
              <BrokenSourcesBanner builderId={builderId} slug={slug} />
            </Suspense>
            {children}
          </main>
        </div>
      </div>
    </>
  );
}
