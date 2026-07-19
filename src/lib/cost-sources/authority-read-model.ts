import { sql } from 'drizzle-orm';
import { withBudgetControlReadTransaction } from '../budget-control/read-transaction.js';
import { unwrapRows } from '../db/query-utils.js';

export interface CostSourceAuthorityState {
  workspaceControlReady: boolean;
  hasActiveHardStopBudget: boolean;
}

interface CostSourceAuthorityRow {
  workspace_control_ready: unknown;
  has_active_hard_stop_budget: unknown;
}

/** Read only the two authority facts needed by the Cost Sources dashboard. */
export function readCostSourceAuthority(builderId: string): Promise<CostSourceAuthorityState> {
  return withBudgetControlReadTransaction(builderId, async (transaction) => {
    const result = await transaction.execute(sql`
      SELECT
        EXISTS (
          SELECT 1
          FROM public.budget_control_cutovers cutover
          WHERE cutover.builder_id = ${builderId}::UUID
            AND cutover.status = 'ready'
        ) AS workspace_control_ready,
        EXISTS (
          SELECT 1
          FROM public.budget_rule_revisions revision
          WHERE revision.builder_id = ${builderId}::UUID
            AND revision.enforcement = 'hard_stop'
            AND revision.retired_at IS NULL
        ) AS has_active_hard_stop_budget
    `);
    const rows = unwrapRows<CostSourceAuthorityRow>(result);
    const row = rows[0];
    if (
      rows.length !== 1 ||
      typeof row?.workspace_control_ready !== 'boolean' ||
      typeof row.has_active_hard_stop_budget !== 'boolean'
    ) {
      throw new Error('cost source authority returned an invalid shape');
    }
    return {
      workspaceControlReady: row.workspace_control_ready,
      hasActiveHardStopBudget: row.has_active_hard_stop_budget,
    };
  });
}
