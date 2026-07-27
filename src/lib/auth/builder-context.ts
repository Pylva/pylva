import type { NextRequest, NextResponse } from 'next/server.js';
import { internalError } from '../errors.js';

export const PRODUCT_ACCESS_VERIFIED_HEADER = 'x-pylva-product-access-verified';

// Read (builderId, keyId) from middleware-injected headers. Returns a 500
// response if middleware didn't run — this should never happen against a
// properly-matchered route, but it's a cheap guard.
export function readBuilderContext(
  request: NextRequest,
): { builderId: string; keyId: string; productAccessVerified: boolean } | NextResponse {
  const builderId = request.headers.get('x-builder-id');
  const keyId = request.headers.get('x-key-id');
  if (!builderId || !keyId) {
    return internalError('middleware did not set x-builder-id / x-key-id');
  }
  return {
    builderId,
    keyId,
    productAccessVerified: request.headers.get(PRODUCT_ACCESS_VERIFIED_HEADER) === '1',
  };
}

// B2a: read dashboard-audience context. builder_id is injected by middleware
// after a successful JWT verify; user_id + role come from the JWT claims.
export function readBuilderContextFromDashboard(
  request: NextRequest,
): { builderId: string; userId: string | null; role: string | null } | NextResponse {
  const builderId = request.headers.get('x-builder-id');
  if (!builderId) return internalError('middleware did not set x-builder-id');
  return {
    builderId,
    userId: request.headers.get('x-user-id'),
    role: request.headers.get('x-user-role'),
  };
}
