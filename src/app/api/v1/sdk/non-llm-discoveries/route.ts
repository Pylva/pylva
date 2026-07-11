import { NextResponse, type NextRequest } from 'next/server.js';
import * as v from 'valibot';
import { sql } from 'drizzle-orm';
import { CostSourceTrackingStatus } from '@pylva/shared';
import { readBuilderContext } from '@/lib/auth/builder-context';
import { withRLS } from '@/lib/db/rls';
import { unwrapRows } from '@/lib/db/query-utils';
import { validationError } from '@/lib/errors';
import { normalizeNonLlmMatcher, displayNameForTool } from '@/lib/non-llm/normalization';

const discoverySchema = v.object({
  tool_name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  matcher: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
  step_name: v.optional(v.union([v.pipe(v.string(), v.maxLength(200)), v.null()])),
  framework: v.optional(v.union([v.pipe(v.string(), v.maxLength(50)), v.null()])),
  status: v.optional(v.union([v.pipe(v.string(), v.maxLength(50)), v.null()])),
  timestamp: v.optional(v.pipe(v.string(), v.isoTimestamp())),
  count: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
});

const requestSchema = v.object({
  batch_id: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(100))),
  discoveries: v.pipe(v.array(discoverySchema), v.minLength(1), v.maxLength(100)),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(requestSchema, body);
  if (!parsed.success) {
    return validationError(parsed.issues[0]?.message ?? 'Invalid discovery payload', 'body');
  }

  const now = new Date();
  let accepted = 0;

  await withRLS(ctx.builderId, async (tx) => {
    for (const discovery of parsed.output.discoveries) {
      const matcher = normalizeNonLlmMatcher(discovery.matcher);
      if (!matcher) continue;
      const count = discovery.count ?? 1;
      const rows = unwrapRows<{
        id: string;
        tracking_status: string;
      }>(
        await tx.execute(sql`
        SELECT id, tracking_status
        FROM cost_sources
        WHERE builder_id = ${ctx.builderId}::uuid
          AND source_type = 'non_llm_manual'
          AND (slug = ${matcher} OR matchers @> ARRAY[${matcher}]::text[])
        LIMIT 1
      `),
      );
      const existing = rows[0];
      if (existing) {
        await tx.execute(sql`
          UPDATE cost_sources
          SET last_discovered_at = ${now},
              discovery_count = discovery_count + ${count}
          WHERE id = ${existing.id}::uuid
        `);
        accepted++;
        continue;
      }

      await tx.execute(sql`
        INSERT INTO cost_sources (
          builder_id, source_type, display_name, slug, tracking_status,
          matchers, last_discovered_at, discovery_count
        )
        VALUES (
          ${ctx.builderId}::uuid,
          'non_llm_manual',
          ${displayNameForTool(discovery.tool_name)},
          ${matcher},
          ${CostSourceTrackingStatus.PENDING},
          ARRAY[${matcher}]::text[],
          ${now},
          ${count}
        )
        ON CONFLICT (builder_id, slug) DO UPDATE
        SET last_discovered_at = EXCLUDED.last_discovered_at,
            discovery_count = cost_sources.discovery_count + EXCLUDED.discovery_count
      `);
      accepted++;
    }
  });

  return NextResponse.json({ accepted, rejected: parsed.output.discoveries.length - accepted });
}
