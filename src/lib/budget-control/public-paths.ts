// Machine-only authoritative budget-control URL namespace.
//
// Match by segment-bounded roots rather than only today's five route shapes.
// This keeps malformed transition URLs and future children from ever falling
// through to dashboard-cookie authentication; the Next route layer still owns
// 404/405 handling and reservation-ID validation.

const AUTHORITATIVE_BUDGET_CONTROL_ROOTS = [
  '/api/v1/budget/capabilities',
  '/api/v1/budget/reservations',
] as const;

export function isAuthoritativeBudgetControlPath(pathname: string): boolean {
  return AUTHORITATIVE_BUDGET_CONTROL_ROOTS.some(
    (root) => pathname === root || pathname.startsWith(`${root}/`),
  );
}
