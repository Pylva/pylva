import type { Metadata } from 'next';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { COPY } from '@/lib/copy';
import { SimulatorClient } from '@/components/simulator/SimulatorClient';
import { db } from '@/lib/db/client';
import { builders, llmPricing } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import type { BuilderTier } from '@pylva/shared';
import { PageHeader } from '@/components/dashboard/PageHeader';

export const metadata: Metadata = { title: 'Cost simulator' };

export default async function SimulatorPage() {
  const { builderId } = await readDashboardHeaders();

  const [builder] = await db
    .select({ tier: builders.tier })
    .from(builders)
    .where(eq(builders.id, builderId))
    .limit(1);

  const tier = (builder?.tier ?? 'free') as BuilderTier;
  const isGated = !['scale', 'enterprise'].includes(tier);

  const pricingRows = isGated
    ? []
    : await db
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

      {isGated ? (
        <div className="app-card mt-8 p-8 text-center">
          <p className="text-lg font-medium">Upgrade to Scale</p>
          <p className="mt-2 text-sm text-[color:var(--muted-foreground)]">
            The cost simulator is available on Scale and Enterprise plans.
          </p>
        </div>
      ) : (
        <SimulatorClient modelsByProvider={grouped} />
      )}
    </>
  );
}
