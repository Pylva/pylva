import { ErrorCode } from '@pylva/shared';
import { NextResponse, type NextRequest } from 'next/server.js';

import { verifyCronSecret } from '@/lib/cron/auth';
import { authError } from '@/lib/errors';

const DEFAULT_MARKER = 'pylva-prod-sentry-smoke';

function sanitizeMarker(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_MARKER;
  const sanitized = value.replace(/[^a-zA-Z0-9._:-]/g, '_').slice(0, 120);
  return sanitized || DEFAULT_MARKER;
}

async function readMarker(request: NextRequest): Promise<string> {
  try {
    const body = (await request.json()) as { marker?: unknown };
    return sanitizeMarker(body.marker);
  } catch {
    return DEFAULT_MARKER;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronSecret(request)) {
    return authError(ErrorCode.INVALID_API_KEY, 'Missing or invalid CRON_SECRET');
  }

  const marker = await readMarker(request);
  throw new Error(`[sentry-smoke] ${marker}`);
}
