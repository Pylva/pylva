// POST /api/v1/events — telemetry ingest (B1 spec §4.10, §7.4).
// Auth + rate limit handled by src/middleware.ts in ECS/Next mode. Lambda mode
// calls the same handler after doing equivalent API-key auth in the adapter.

import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContext } from '../../../../lib/auth/builder-context.js';
import { handleTelemetryIngest } from '../../../../lib/ingest/public-handler.js';
import { toNextResponse } from '../../../../lib/public-http/response.js';

export async function POST(request: NextRequest): Promise<Response> {
  const ctx = readBuilderContext(request);
  if (ctx instanceof NextResponse) return ctx;
  const { builderId, keyId } = ctx;

  return toNextResponse(
    await handleTelemetryIngest({
      builderId,
      keyId,
      rawBody: await request.text(),
    }),
  );
}
