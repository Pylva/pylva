import crypto from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getBudgetAccountState,
  listBudgetActivity,
} from '../../src/lib/budget-activity/read-model.js';
import { parseBudgetActivityQuery } from '../../src/lib/budget-activity/query.js';
import { readCostSourceAuthority } from '../../src/lib/cost-sources/authority-read-model.js';

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://pylva:pylva_dev@localhost:5432/pylva';

let general: Sql;
let builderId: string;

beforeAll(async () => {
  general = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
  const suffix = crypto.randomBytes(6).toString('hex');
  const rows = await general<{ id: string }[]>`
    INSERT INTO public.builders (email, name, tier, slug)
    VALUES (
      ${`budget-activity-boundary-${suffix}@example.com`},
      'Budget activity runtime boundary',
      'pro',
      ${`budget-activity-boundary-${suffix}`}
    )
    RETURNING id::TEXT AS id
  `;
  builderId = rows[0]!.id;
});

afterAll(async () => {
  if (builderId) await general`DELETE FROM public.builders WHERE id = ${builderId}::UUID`;
  await general?.end();
  await import('../../src/lib/budget-control/client.js')
    .then(({ closeBudgetControlDb }) => closeBudgetControlDb())
    .catch(() => undefined);
});

describe('budget activity runtime credential boundary', () => {
  it('reads authority state through the dedicated runtime while the general login is denied', async () => {
    await expect(
      general.begin(async (transaction) => {
        await transaction`
          SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
        `;
        return transaction`SELECT COUNT(*) FROM public.budget_reservations`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
    for (const table of ['budget_control_cutovers', 'budget_rule_revisions']) {
      await expect(
        general.begin(async (transaction) => {
          await transaction`
            SELECT pg_catalog.set_config('app.builder_id', ${builderId}::UUID::TEXT, TRUE)
          `;
          return transaction.unsafe(`SELECT builder_id FROM public.${table} LIMIT 1`);
        }),
      ).rejects.toMatchObject({ code: '42501' });
    }

    await expect(
      listBudgetActivity(builderId, parseBudgetActivityQuery(new URLSearchParams())),
    ).resolves.toMatchObject({
      authority: 'postgresql',
      activities: [],
      pagination: { total: 0, total_pages: 0 },
    });
    await expect(
      getBudgetAccountState(builderId, { customer_id: 'no-authority-events' }),
    ).resolves.toEqual([]);
    await expect(readCostSourceAuthority(builderId)).resolves.toEqual({
      workspaceControlReady: false,
      hasActiveHardStopBudget: false,
    });
  });
});
