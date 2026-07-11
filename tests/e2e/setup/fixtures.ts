// Shared constants for the authenticated dashboard e2e suite. Plain module
// (not a test file) so both the setup project, the fixture seed script, and
// the specs can import it — Playwright forbids test files importing each
// other, and importing the seed script would execute it.

export const DASHBOARD_STORAGE_STATE = 'playwright/.auth/dashboard.json';

// Stable builder slug from db/seed.ts.
export const DASHBOARD_ORG_SLUG = 'alice-free';

// Customer ids seeded by seed-dashboard-fixtures.ts. Deliberately include a
// very long id (from the bug-report screenshots) and an Arabic id (RTL is a
// product constraint).
export const FIXTURE_CUSTOMER_IDS = {
  normal: 'cust_orbit_support',
  long: 'pylva-cutover-1782093690217',
  arabic: 'عميل-الشركة-السعودية',
} as const;

export const FIXTURE_CUSTOMER_UUID = 'e2ec0000-0000-4000-8000-000000000001';

export const FIXTURE_INVOICE_IDS = {
  paid: 'e2e10000-0000-4000-8000-000000000001',
  draftUnpriced: 'e2e10000-0000-4000-8000-000000000002',
  splitCycle: 'e2e10000-0000-4000-8000-000000000003',
} as const;

export const FIXTURE_CYCLE_UUID = 'e2ecc000-0000-4000-8000-000000000001';
