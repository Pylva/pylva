// Liveness probe for ECS / ALB health checks.
//
// Deliberately shallow: asserts only that the Node process can serve HTTP.
// It does NOT touch Postgres, Redis, or ClickHouse — the deep dependency
// check is GET /api/v1/health. ClickHouse is deferred (2.4 / T#8) so
// /api/v1/health returns 503 indefinitely in staging; an ECS health check
// must target THIS route, or the service would never stabilize. Liveness
// is not readiness: a transient DB blip must not trigger a task-kill storm.

import { NextResponse } from 'next/server.js';

export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
