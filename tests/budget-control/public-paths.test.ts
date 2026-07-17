import { describe, expect, it } from 'vitest';
import { isAuthoritativeBudgetControlPath } from '../../src/lib/budget-control/public-paths.js';

const RESERVATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('authoritative budget-control public path classification', () => {
  it.each([
    ['/api/v1/budget/capabilities'],
    ['/api/v1/budget/reservations'],
    [`/api/v1/budget/reservations/${RESERVATION_ID}/commit`],
    [`/api/v1/budget/reservations/${RESERVATION_ID}/release`],
    [`/api/v1/budget/reservations/${RESERVATION_ID}/extend`],
  ])('classifies the public control path %s as machine-only', (pathname) => {
    expect(isAuthoritativeBudgetControlPath(pathname)).toBe(true);
  });

  it.each([
    ['/api/v1/budget/capabilities/'],
    ['/api/v1/budget/capabilities/future-version'],
    ['/api/v1/budget/reservations/'],
    [`/api/v1/budget/reservations/${RESERVATION_ID}`],
    [`/api/v1/budget/reservations/${RESERVATION_ID}/unknown-transition`],
    [`/api/v1/budget/reservations/${RESERVATION_ID}/commit/extra`],
    ['/api/v1/budget/reservations/client-opaque.id:route-safe/release'],
  ])('keeps the segment-bounded control namespace machine-only for %s', (pathname) => {
    expect(isAuthoritativeBudgetControlPath(pathname)).toBe(true);
  });

  it.each([
    ['/api/v1/budget'],
    ['/api/v1/budget/sync'],
    ['/api/v1/budget/capability'],
    ['/api/v1/budget/capabilities-legacy'],
    ['/api/v1/budget/reservation'],
    ['/api/v1/budget/reservations-legacy'],
    ['/api/v2/budget/reservations'],
    ['/api/v1/custom-pricing'],
  ])('does not capture the unrelated path %s', (pathname) => {
    expect(isAuthoritativeBudgetControlPath(pathname)).toBe(false);
  });
});
