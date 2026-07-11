// B2a — Slack alert channel (Block Kit via Incoming Webhook URL).
// Distinct from src/lib/alerts/slack.ts (internal B1 team-notify helper).
// Full Block Kit builder lives in src/lib/alerts/templates/slack/block-builder.ts;
// T4a polishes the batched summary variant.

import { logger } from '../../logger.js';
import { retryWithBackoff, isRetryableHttpError } from '../retry.js';
import { writeToDlq } from '../dlq.js';
import { buildAlertBlocks } from '../templates/slack/block-builder.js';
import { externalFetch } from '../../external-egress.js';
import type { ChannelDeliverFn } from './channel.interface.ts';
import type { AlertPayload, RuleAlertChannelSlack } from '@pylva/shared';

const log = logger.child({ module: 'alerts.slack' });
const SLACK_FETCH_TIMEOUT_MS = 15_000;

export const deliverSlack: ChannelDeliverFn = async (payloads, entry, ctx) => {
  if (entry.channel !== 'slack') {
    throw new Error(
      `[alerts.slack] non-slack entry routed to slack channel (got ${entry.channel})`,
    );
  }
  const slackEntry = entry as RuleAlertChannelSlack;

  const blocks = buildAlertBlocks(payloads);
  const body = JSON.stringify({ blocks });

  const result = await retryWithBackoff(
    async () => {
      const res = await externalFetch({
        target: 'slack',
        url: slackEntry.slack_webhook_url,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeoutMs: SLACK_FETCH_TIMEOUT_MS,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`slack POST failed: ${res.status} ${res.statusText}`);
      }
    },
    { retryable: isRetryableHttpError },
  );

  if (!result.ok) {
    await writeToDlq({
      builder_id: ctx.builder_id,
      channel: 'slack',
      webhook_config_id: null,
      event_type: 'rule.fired',
      payload: payloads as unknown as Record<string, unknown>,
      channel_config_snapshot: { slack_webhook_url: slackEntry.slack_webhook_url },
      last_error: result.last_error ?? 'unknown',
      attempts: result.attempts,
    });
  }

  log.debug(
    { builder_id: ctx.builder_id, rule_id: ctx.rule_id, attempts: result.attempts },
    'slack dispatched',
  );

  return {
    ok: result.ok,
    attempts: result.attempts,
    ...(result.last_error ? { last_error: result.last_error } : {}),
  };
};

export type { AlertPayload };
