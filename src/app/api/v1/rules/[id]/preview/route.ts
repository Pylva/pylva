// POST /api/v1/rules/{id}/preview — read-only impact preview. Returns the
// top-20 customers / steps / models the rule would touch in the last 30
// days. Never mutates rule status. Powers the dashboard's "preview impact"
// CTA and the inline confirmation panel on activate.

import { NextResponse, type NextRequest } from 'next/server.js';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '../../../../../../lib/auth/builder-context.js';
import { getRule } from '../../../../../../lib/rules/repository.js';
import { previewRule } from '../../../../../../lib/rules/preview.js';
import { authError, internalError, notFoundError } from '../../../../../../lib/errors.js';
import { logger } from '../../../../../../lib/logger.js';

const log = logger.child({ module: 'rules.preview' });

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  const { id } = await params;
  const rule = await getRule(ctx.builderId, id);
  if (!rule) return notFoundError(ErrorCode.NOT_FOUND, 'Rule not found');

  try {
    const preview = await previewRule(rule);
    return NextResponse.json({ preview });
  } catch (err) {
    log.error(
      {
        builder_id: ctx.builderId,
        rule_id: id,
        error: err instanceof Error ? err.message : String(err),
      },
      'rule preview failed',
    );
    return internalError('Failed to compute rule preview');
  }
}
