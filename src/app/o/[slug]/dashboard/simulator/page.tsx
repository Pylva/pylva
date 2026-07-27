import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { checkDashboardFeatureGate } from '@/lib/auth/dashboard-feature-gate';
import { COPY } from '@/lib/copy';
import { SimulatorClient } from '@/components/simulator/SimulatorClient';
import { db } from '@/lib/db/client';
import { llmPricing } from '@/lib/db/schema';
import { PageHeader } from '@/components/dashboard/PageHeader';

export const metadata: Metadata = { title: 'Cost simulator' };

export default async function SimulatorPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ builderId }, { slug }] = await Promise.all([readDashboardHeaders(), params]);
  const gateResult = await checkDashboardFeatureGate(builderId, 'simulator');

  if (gateResult) {
    const planLocked = gateResult.status === 403;
    return (
      <>
        <PageHeader title={COPY.simulator_page_title} description={COPY.simulator_page_subtitle} />
        <div
          role="region"
          aria-label="Cost simulator locked"
          className="app-card mt-8 p-8 text-center"
        >
          <p className="text-lg font-medium">
            {planLocked ? 'Upgrade to Scale' : 'Cost simulator unavailable'}
          </p>
          <p className="mt-2 text-sm text-[color:var(--muted-foreground)]">
            {planLocked
              ? 'The cost simulator is available on Scale and Enterprise plans.'
              : 'Workspace entitlement could not be verified. Try again later.'}
          </p>
          {planLocked ? (
            <a
              href={`/o/${slug}/subscription`}
              className="mt-6 inline-flex items-center justify-center rounded-md px-4 py-2 text-sm font-medium"
              style={{
                background: 'var(--primary)',
                color: 'var(--primary-foreground)',
              }}
            >
              Change plan
            </a>
          ) : null}
        </div>
      </>
    );
  }

  const pricingRows = await db
    .select({
      provider: llmPricing.provider,
      model: llmPricing.model,
      input_per_1m: llmPricing.input_per_1m,
      output_per_1m: llmPricing.output_per_1m,
    })
    .from(llmPricing);

  const grouped: Record<
    string,
    Array<{ model: string; input_per_1m: number; output_per_1m: number }>
  > = {};
  const seen = new Set<string>();
  for (const row of pricingRows) {
    const key = `${row.provider}:${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = grouped[row.provider] ?? [];
    list.push({
      model: row.model,
      input_per_1m: Number(row.input_per_1m),
      output_per_1m: Number(row.output_per_1m),
    });
    grouped[row.provider] = list;
  }

  return (
    <>
      <PageHeader title={COPY.simulator_page_title} description={COPY.simulator_page_subtitle} />
      <SimulatorClient modelsByProvider={grouped} />
    </>
  );
}
