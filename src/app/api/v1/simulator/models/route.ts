import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { db } from '@/lib/db/client';
import { llmPricing } from '@/lib/db/schema';
import { env } from '@/lib/config';

interface ModelEntry {
  provider: string;
  model: string;
  input_per_1m: number;
  output_per_1m: number;
}

interface GroupedModels {
  [provider: string]: ModelEntry[];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.ENABLE_SIMULATOR) {
    return NextResponse.json(
      { error: { code: 'FEATURE_DISABLED', message: 'Cost simulator is currently disabled' } },
      { status: 503 },
    );
  }

  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const rows = await db
    .select({
      provider: llmPricing.provider,
      model: llmPricing.model,
      input_per_1m: llmPricing.input_per_1m,
      output_per_1m: llmPricing.output_per_1m,
    })
    .from(llmPricing);

  const grouped: GroupedModels = {};
  const seen = new Set<string>();

  for (const row of rows) {
    const key = `${row.provider}:${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const entry: ModelEntry = {
      provider: row.provider,
      model: row.model,
      input_per_1m: Number(row.input_per_1m),
      output_per_1m: Number(row.output_per_1m),
    };
    const list = grouped[row.provider] ?? [];
    list.push(entry);
    grouped[row.provider] = list;
  }

  return NextResponse.json({ models: grouped });
}
