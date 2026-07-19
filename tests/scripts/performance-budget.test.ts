import { describe, expect, it } from 'vitest';

import {
  routeBudgets,
  routeBudgetViolation,
  type RouteBudget,
} from '../../scripts/assert-performance-budget.js';

function budgetFor(route: string): RouteBudget {
  const budget = routeBudgets.find((candidate) => candidate.route === route);
  if (!budget) throw new Error(`missing test budget for ${route}`);
  return budget;
}

const sharedRuntimeFiles = [
  'static/chunks/webpack-e8bf3e18026648f9.js',
  'static/chunks/8c1a8fc1-9f54873c1a5ac098.js',
  'static/chunks/8b142b19-a4c057eb8cd09857.js',
  'static/chunks/8429-0fe1b743f0fcbe8d.js',
  'static/chunks/main-app-e7f0d6eb32654e2c.js',
] as const;

describe('performance budget baselines', () => {
  it('accepts the measured Sentry 10.65 shared chunk without hiding a second request', () => {
    const budget = budgetFor('/login/page');
    const files = [
      ...sharedRuntimeFiles,
      'static/chunks/8485-5d5d48f5912e36c0.js',
      'static/chunks/app/login/page-db81a209b7f7a79d.js',
    ];

    expect(routeBudgetViolation(budget, files, 634)).toBeUndefined();
    expect(
      routeBudgetViolation(
        budget,
        [...files, 'static/chunks/app/login/unexpected-page-chunk.js'],
        634,
      ),
    ).toContain('loaded 8 files; budget is 7');
  });

  it('keeps the measured dashboard byte ceilings exact', () => {
    const dashboard = budgetFor('/o/[slug]/dashboard/page');
    const apiKeys = budgetFor('/o/[slug]/dashboard/settings/api-keys/page');

    expect(routeBudgetViolation(dashboard, sharedRuntimeFiles, 652)).toBeUndefined();
    expect(routeBudgetViolation(dashboard, sharedRuntimeFiles, 653)).toContain(
      '653 KiB raw; budget is 652 KiB',
    );
    expect(routeBudgetViolation(apiKeys, sharedRuntimeFiles, 654)).toBeUndefined();
    expect(routeBudgetViolation(apiKeys, sharedRuntimeFiles, 655)).toContain(
      '655 KiB raw; budget is 654 KiB',
    );
  });

  it('still rejects avoidable named chunks below the count and byte ceilings', () => {
    const budget = budgetFor('/portal/page');

    expect(
      routeBudgetViolation(
        budget,
        [...sharedRuntimeFiles.slice(0, 4), 'static/chunks/avoidable-feature.js'],
        1,
      ),
    ).toContain('has avoidable extra chunks: static/chunks/avoidable-feature.js');
  });
});
