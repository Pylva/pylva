import assert from 'node:assert/strict';
import { closeBudgetControlDb } from '../../src/lib/budget-control/client.js';
import { runBudgetReservationExpiry } from '../../src/lib/budget-control/expiry-runner.js';

const expectedBuilders = (process.env['EXPECTED_EXPIRY_BUILDERS'] ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

assert.ok(
  expectedBuilders.length > 0,
  'EXPECTED_EXPIRY_BUILDERS must identify at least one tenant',
);

const observedBuilders: string[] = [];

try {
  const result = await runBudgetReservationExpiry(
    {},
    {
      // Force keyset pagination through more than one discovery call.
      builderPageSize: 1,
      builderConcurrency: 2,
      expireForBuilder: async (builderId, limit) => {
        assert.equal(limit, 100);
        observedBuilders.push(builderId);
        return { expired: 0 };
      },
    },
  );

  assert.deepEqual(observedBuilders, expectedBuilders);
  assert.deepEqual(result, {
    scanned_builders: expectedBuilders.length,
    expired_reservations: 0,
    errors: 0,
  });
  process.stdout.write('AUTHORITATIVE_EXPIRY_RUNNER_OK\n');
} finally {
  await closeBudgetControlDb();
}
