// Concierge custom-rule request flow. The dashboard user writes only the rule
// idea; verified account/workspace context is attached server-side.

import { NextResponse, type NextRequest } from 'next/server.js';
import { eq } from 'drizzle-orm';
import * as v from 'valibot';
import { ErrorCode } from '@pylva/shared';
import { readBuilderContextFromDashboard } from '@/lib/auth/builder-context';
import { withRateLimit } from '@/lib/auth/middleware';
import { env } from '@/lib/config';
import { db } from '@/lib/db/client';
import { builders, customRuleRequests, users } from '@/lib/db/schema';
import { withRLS } from '@/lib/db/rls';
import { authError, internalError, validationError } from '@/lib/errors';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'rules.custom-request' });

const MIN_IDEA_LENGTH = 10;
const MAX_IDEA_LENGTH = 4000;
const CUSTOM_RULE_REQUEST_RATE_LIMIT = { maxRequests: 1, windowMs: 5 * 60 * 1000 } as const;
// Coarse payload guard only; the authoritative length check runs on code points
// below. A code point is at most two UTF-16 units, so `MAX_IDEA_LENGTH * 2`
// admits every value the DB CHECK accepts (all-astral text) without false rejects.
const BodySchema = v.object({
  idea: v.pipe(v.string(), v.maxLength(MAX_IDEA_LENGTH * 2)),
});

type EmailStatus = 'sent' | 'partial_failure' | 'failed' | 'skipped';

interface Requester {
  email: string;
  displayName: string | null;
}

interface Workspace {
  id: string;
  name: string | null;
  slug: string;
  email: string;
  tier: string;
}

interface CustomRuleRequestEmailInput {
  idea: string;
  requester: Requester;
  workspace: Workspace;
  submittedAt: Date;
}

interface CustomRuleRequestEmailResult {
  internalEmailSent: boolean;
  receiptEmailSent: boolean;
  emailStatus: EmailStatus;
  lastEmailError: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = readBuilderContextFromDashboard(request);
  if (ctx instanceof NextResponse) return ctx;
  if (!ctx.userId) return authError(ErrorCode.INVALID_API_KEY, 'No user context');

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationError('Invalid JSON body', 'body');
  }

  const parsed = v.safeParse(BodySchema, body);
  if (!parsed.success) {
    return validationError(parsed.issues[0]?.message ?? 'Invalid request', 'idea');
  }

  const idea = parsed.output.idea.trim();
  // Count Unicode code points to match the Postgres `char_length` CHECK on this
  // column (migration 044: `char_length(idea) BETWEEN 10 AND 4000`). String.length
  // counts UTF-16 code units, so e.g. 5 emoji have length 10 but char_length 5 —
  // that would pass a `.length` guard, then violate the CHECK inside the INSERT,
  // surfacing as an uncaught 500 with the submission lost and the rate limit spent.
  const ideaLength = [...idea].length;
  if (ideaLength < MIN_IDEA_LENGTH) {
    return validationError('Please share a little more detail before submitting.', 'idea');
  }
  if (ideaLength > MAX_IDEA_LENGTH) {
    return validationError('Please shorten your idea before submitting.', 'idea');
  }

  const rateLimited = await withRateLimit(
    `custom_rule_request:${ctx.userId}`,
    CUSTOM_RULE_REQUEST_RATE_LIMIT,
  );
  if (rateLimited) return rateLimited;

  const [requester, workspace] = await Promise.all([
    db
      .select({ email: users.email, displayName: users.display_name })
      .from(users)
      .where(eq(users.id, ctx.userId))
      .limit(1),
    db
      .select({
        id: builders.id,
        name: builders.name,
        slug: builders.slug,
        email: builders.email,
        tier: builders.tier,
      })
      .from(builders)
      .where(eq(builders.id, ctx.builderId))
      .limit(1),
  ]);

  const userRow = requester[0];
  if (!userRow) return authError(ErrorCode.INVALID_API_KEY, 'User not found');
  const workspaceRow = workspace[0];
  if (!workspaceRow) return authError(ErrorCode.INVALID_API_KEY, 'Workspace not found');

  const submittedAt = new Date();
  const [requestRow] = await withRLS(ctx.builderId, async (tx) =>
    tx
      .insert(customRuleRequests)
      .values({
        builder_id: ctx.builderId,
        requester_user_id: ctx.userId,
        requester_email: userRow.email,
        requester_display_name: userRow.displayName,
        workspace_name: workspaceRow.name,
        workspace_slug: workspaceRow.slug,
        workspace_email: workspaceRow.email,
        workspace_tier: workspaceRow.tier,
        idea,
        email_status: 'pending',
        internal_email_sent: false,
        receipt_email_sent: false,
        submitted_at: submittedAt,
        updated_at: submittedAt,
      })
      .returning({ id: customRuleRequests.id }),
  );
  if (!requestRow) {
    log.error({ builder_id: ctx.builderId }, 'custom rule request persistence returned no row');
    return internalError('Could not store custom rule request');
  }

  const result = await sendCustomRuleRequestEmails({
    idea,
    requester: userRow,
    workspace: workspaceRow,
    submittedAt,
  });

  try {
    await withRLS(ctx.builderId, async (tx) => {
      await tx
        .update(customRuleRequests)
        .set({
          email_status: result.emailStatus,
          internal_email_sent: result.internalEmailSent,
          receipt_email_sent: result.receiptEmailSent,
          last_email_error: result.lastEmailError,
          updated_at: new Date(),
        })
        .where(eq(customRuleRequests.id, requestRow.id));
    });
  } catch (err) {
    const message = emailErrorMessage(err);
    log.error(
      {
        error: message,
        builder_id: ctx.builderId,
        request_id: requestRow.id,
        email_status: result.emailStatus,
        internal_email_sent: result.internalEmailSent,
        receipt_email_sent: result.receiptEmailSent,
      },
      'custom rule request email status update failed',
    );
  }

  return NextResponse.json(
    {
      ok: true,
      request_id: requestRow.id,
      internal_email_sent: result.internalEmailSent,
      receipt_email_sent: result.receiptEmailSent,
    },
    { status: 202 },
  );
}

async function sendCustomRuleRequestEmails(
  input: CustomRuleRequestEmailInput,
): Promise<CustomRuleRequestEmailResult> {
  if (!env.RESEND_API_KEY) {
    log.warn(
      { builder_id: input.workspace.id, requester_email: input.requester.email },
      'RESEND_API_KEY not set; custom rule request email skipped',
    );
    if (env.NODE_ENV !== 'production') {
      console.warn(`[DEV] Custom rule request from ${input.requester.email}:\n${input.idea}`);
    }
    return {
      internalEmailSent: false,
      receiptEmailSent: false,
      emailStatus: 'skipped',
      lastEmailError: 'RESEND_API_KEY not configured',
    };
  }

  const { Resend } = await import('resend');
  const client = new Resend(env.RESEND_API_KEY);

  // Internal notification to Pylva is sent only when a recipient is configured.
  // Self-host leaves CUSTOM_RULE_REQUEST_EMAIL unset → request is stored locally,
  // nothing is emailed to Pylva. The requester receipt below goes to the user's
  // own address, so it is unaffected by this gate.
  const internalRecipient = env.CUSTOM_RULE_REQUEST_EMAIL;
  let internalEmailSent = false;
  if (internalRecipient) {
    let internal;
    try {
      internal = await client.emails.send({
        from: env.INVITE_FROM_EMAIL,
        to: [internalRecipient],
        subject: `Custom rule request: ${workspaceLabel(input.workspace)}`,
        html: renderInternalEmail(input),
      });
    } catch (err) {
      const message = emailErrorMessage(err);
      log.error(
        { error: message, builder_id: input.workspace.id },
        'custom rule request internal email failed',
      );
      return {
        internalEmailSent: false,
        receiptEmailSent: false,
        emailStatus: 'failed',
        lastEmailError: message,
      };
    }

    if (internal.error) {
      const message = emailErrorMessage(internal.error);
      log.error(
        { error: message, builder_id: input.workspace.id },
        'custom rule request internal email failed',
      );
      return {
        internalEmailSent: false,
        receiptEmailSent: false,
        emailStatus: 'failed',
        lastEmailError: message,
      };
    }
    internalEmailSent = true;
  }

  let receipt;
  try {
    receipt = await client.emails.send({
      from: env.INVITE_FROM_EMAIL,
      to: [input.requester.email],
      subject: 'We received your custom rule request',
      html: renderReceiptEmail(input),
    });
  } catch (err) {
    const message = emailErrorMessage(err);
    log.warn(
      { error: message, builder_id: input.workspace.id },
      'custom rule request receipt email failed',
    );
    return {
      internalEmailSent,
      receiptEmailSent: false,
      emailStatus: 'partial_failure',
      lastEmailError: message,
    };
  }

  if (receipt.error) {
    const message = emailErrorMessage(receipt.error);
    log.warn(
      { error: message, builder_id: input.workspace.id },
      'custom rule request receipt email failed',
    );
    return {
      internalEmailSent,
      receiptEmailSent: false,
      emailStatus: 'partial_failure',
      lastEmailError: message,
    };
  }

  return {
    internalEmailSent,
    receiptEmailSent: true,
    emailStatus: 'sent',
    lastEmailError: null,
  };
}

function renderInternalEmail(input: CustomRuleRequestEmailInput): string {
  const submittedAt = input.submittedAt.toISOString();
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:680px;margin:32px auto;color:#222">
  <h2 style="font-size:18px">Custom rule request</h2>
  <p><strong>Workspace:</strong> ${escapeHtml(workspaceLabel(input.workspace))}</p>
  <p><strong>Workspace ID:</strong> ${escapeHtml(input.workspace.id)}</p>
  <p><strong>Tier:</strong> ${escapeHtml(input.workspace.tier)}</p>
  <p><strong>Account email:</strong> ${escapeHtml(input.workspace.email)}</p>
  <p><strong>Requester:</strong> ${escapeHtml(requesterLabel(input.requester))}</p>
  <p><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:24px 0" />
  <p style="white-space:pre-wrap">${escapeHtml(input.idea)}</p>
</body></html>`;
}

function renderReceiptEmail(input: CustomRuleRequestEmailInput): string {
  return `<!doctype html>
<html><body style="font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;color:#222">
  <h2 style="font-size:18px">We received your custom rule request</h2>
  <p>Thank you for sharing the idea. We appreciate it and are reviewing it.</p>
  <p>We attached your workspace details automatically, so there is nothing else you need to send right now.</p>
  <hr style="border:none;border-top:1px solid #ddd;margin:24px 0" />
  <p style="color:#666;font-size:13px;margin-bottom:8px">Your request:</p>
  <p style="white-space:pre-wrap">${escapeHtml(input.idea)}</p>
</body></html>`;
}

function workspaceLabel(workspace: Workspace): string {
  return workspace.name ? `${workspace.name} (${workspace.slug})` : workspace.slug;
}

function requesterLabel(requester: Requester): string {
  return requester.displayName ? `${requester.displayName} <${requester.email}>` : requester.email;
}

function emailErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  return String(error);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
