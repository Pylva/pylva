import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('tests/e2e/setup/seed-authoritative-budget-journey.ts', 'utf8');

function section(start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(0);
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('authoritative Playwright seed database boundary', () => {
  it('requires a dedicated budget-control principal without a general-pool fallback', () => {
    expect(source).toContain('const generalClient = postgres(generalDatabaseUrl');
    expect(source).toContain('const budgetClient = postgres(budgetControlDatabase.databaseUrl');
    expect(source).toContain("ALLOW_BUDGET_CONTROL_DATABASE_URL_FALLBACK: 'false'");
    expect(source).not.toContain('BUDGET_CONTROL_DATABASE_URL ??=');
    expect(source).not.toContain('budgetClient = generalClient');
  });

  it('uses the general client only for legacy builder, cost-source, and invoice access', () => {
    expect(source).toContain('const builders = await generalClient');
    expect(source).toContain('await configureToolPricing(generalClient, builderId)');
    expect(source).toContain('legacyBillingSnapshot(generalClient, builderId)');

    const authority = section(
      'async function authoritySnapshot',
      'async function legacyBillingSnapshot',
    );
    expect(authority).not.toContain('public.invoices');

    const legacyBilling = section(
      'async function legacyBillingSnapshot',
      'async function journeySnapshot',
    );
    expect(legacyBilling).toContain('public.invoices');
    expect(legacyBilling).not.toContain('public.budget_');
  });

  it('routes every control lifecycle and projection operation through the budget client', () => {
    expect(source).toMatch(
      /createBudgetControlCutover\([\s\S]*?client: budgetClient,[\s\S]*?markBudgetControlReady\(builderId, \{ client: budgetClient/u,
    );
    expect(source).toContain('configureRule(budgetClient, builderId)');
    expect(source).toMatch(/createReserveBudgetUsage\(\{\s*client: budgetClient,/u);
    expect(source).toContain('transactionOptions: { client: budgetClient, maxAttempts: 1 }');
    expect(source).toContain('committedPrimaryOperationCount(budgetClient, builderId)');
    expect(source).toContain('reservationState(budgetClient, builderId');
    expect(source).toContain('authoritySnapshot(budgetClient, builderId)');
    expect(source).toContain('assertJourneyRows(budgetClient, builderId)');
    expect(source).toContain('assertProjection(budgetClient, builderId)');

    expect(source).not.toContain('configureRule(generalClient');
    expect(source).not.toContain('committedPrimaryOperationCount(generalClient');
    expect(source).not.toContain('reservationState(generalClient');
    expect(source).not.toContain('authoritySnapshot(generalClient');
    expect(source).not.toContain('assertJourneyRows(generalClient');
    expect(source).not.toContain('assertProjection(generalClient');
  });
});
