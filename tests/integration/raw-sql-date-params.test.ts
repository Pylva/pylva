// Regression: raw `db.execute(sql\`…\`)` goes through postgres.js
// unsafe(), which rejects Date parameters outright (TypeError: "argument
// must be of type string or Buffer"). Three cron/activation paths bound
// Dates and were broken end-to-end:
//   - loadModelTierCatalog → crashed the ENTIRE detect-anomalies run
//   - fetchActiveBackupPrice → crashed failover activation's snapshot
//   - expireStaleAnomalies → failed every sweep (soft-caught as a warning)
// Unit suites mocked these modules, so only a live-DB call catches it.

import { describe, expect, it } from 'vitest';
import { loadModelTierCatalog } from '../../src/lib/anomaly/model-tier-catalog.js';
import { expireStaleAnomalies } from '../../src/lib/anomaly/repository.js';
import { fetchActiveBackupPrice } from '../../src/lib/rules/backup-price-snapshot.js';

describe('raw db.execute date-param regression', () => {
  it('loadModelTierCatalog runs against the live database', async () => {
    const catalog = await loadModelTierCatalog(new Date());
    expect(catalog).toBeTruthy();
  });

  it('fetchActiveBackupPrice runs against the live database', async () => {
    // Row may or may not exist — the regression was the query THROWING.
    const price = await fetchActiveBackupPrice('openai', 'gpt-4o', new Date());
    expect(price === null || typeof price.input_per_1m_usd === 'number').toBe(true);
  });

  it('expireStaleAnomalies runs against the live database', async () => {
    const expired = await expireStaleAnomalies(new Date());
    expect(expired).toBeGreaterThanOrEqual(0);
  });
});
