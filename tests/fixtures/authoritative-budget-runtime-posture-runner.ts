import assert from 'node:assert/strict';
import {
  closeBudgetControlDb,
  getBudgetControlClientMetadata,
} from '../../src/lib/budget-control/client.js';
import {
  getBudgetControlProductionPosture,
  getReadyBudgetControlSql,
} from '../../src/lib/budget-control/runtime-posture.js';

try {
  assert.equal(process.env['NODE_ENV'], 'production');
  assert.equal(process.env['ENABLE_AUTHORITATIVE_BUDGET_CONTROL'], 'true');
  assert.equal(process.env['MIGRATION_DATABASE_URL']?.trim() ?? '', '');

  const posture = await getBudgetControlProductionPosture();
  assert.deepEqual(posture, {
    ready: true,
    reason: null,
    attested: true,
    credential_source: 'dedicated',
  });

  const sql = await getReadyBudgetControlSql();
  const [identity] = await sql<Array<{ current_user: string; session_user: string }>>`
    SELECT CURRENT_USER AS current_user, SESSION_USER AS session_user
  `;
  const metadata = getBudgetControlClientMetadata();
  assert.equal(identity?.current_user, metadata.expectedUsername);
  assert.equal(identity?.session_user, metadata.expectedUsername);
  process.stdout.write('AUTHORITATIVE_BUDGET_PRODUCTION_POSTURE_OK\n');
} finally {
  await closeBudgetControlDb();
}
