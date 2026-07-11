import { NextResponse, type NextRequest } from 'next/server.js';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { searchCustomerSelectorOptions } from '@/lib/customers/lookup';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;

  const { searchParams } = new URL(request.url);
  const search = searchParams.get('search') ?? '';
  const limit = Number(searchParams.get('limit') ?? '500');
  const result = await searchCustomerSelectorOptions(ctx.builderId, search, limit);

  return NextResponse.json(result);
}
