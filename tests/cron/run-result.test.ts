// Unit tests for the shared builder-loop cron failure predicate.

import { describe, it, expect } from 'vitest';
import { allScannedBuildersFailed } from '../../src/lib/cron/run-result.js';

describe('allScannedBuildersFailed', () => {
  it('is true when every scanned builder errored (systemic outage)', () => {
    expect(allScannedBuildersFailed({ scanned_builders: 4, errors: 4 })).toBe(true);
  });

  it('is false on a partial failure (per-builder isolation preserved)', () => {
    expect(allScannedBuildersFailed({ scanned_builders: 4, errors: 1 })).toBe(false);
  });

  it('is false when there are no errors', () => {
    expect(allScannedBuildersFailed({ scanned_builders: 4, errors: 0 })).toBe(false);
  });

  it('is false when no builders were scanned (nothing to check ≠ outage)', () => {
    expect(allScannedBuildersFailed({ scanned_builders: 0, errors: 0 })).toBe(false);
  });
});
