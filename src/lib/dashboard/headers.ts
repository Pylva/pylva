// B2a T1 — helper for RSC server-side reads of middleware-injected headers.
// Dashboard page components derive builder_id / user_id / role from these
// headers rather than from URL params or request body (I-T1-3 — no
// builder_id imports in components).

import { headers } from 'next/headers.js';
import type { Role as RoleType } from '@pylva/shared';

export interface DashboardHeaderContext {
  builderId: string;
  userId: string;
  role: RoleType;
  pathname: string;
}

/**
 * Read middleware-injected headers. Throws if any are missing — that's an
 * invariant violation (the middleware matcher should catch every /o/{slug}
 * request first).
 */
export async function readDashboardHeaders(): Promise<DashboardHeaderContext> {
  const h = await headers();
  const builderId = h.get('x-builder-id');
  const userId = h.get('x-user-id');
  const role = h.get('x-user-role') as RoleType | null;
  const pathname = h.get('x-pathname');
  if (!builderId || !userId || !role || !pathname) {
    throw new Error(
      '[dashboard] middleware did not inject required x-builder-id / x-user-id / x-user-role / x-pathname',
    );
  }
  return { builderId, userId, role, pathname };
}
