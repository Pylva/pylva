import { NextResponse } from 'next/server';
import { buildOpenApiDocument } from '@/lib/public-api/openapi';

export const dynamic = 'force-static';

export function GET() {
  return new NextResponse(JSON.stringify(buildOpenApiDocument()), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
