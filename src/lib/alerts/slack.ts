// One-shot Slack incoming-webhook POST. No-op when SLACK_ALERT_WEBHOOK_URL is
// unset. Swallows network errors — alerting is best-effort; a failed POST
// must never surface as a 500 on the caller's hot path.

import { env } from '../config.js';
import { externalFetch } from '../external-egress.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'alerts.slack' });

export async function postSlackAlert(message: string): Promise<void> {
  const url = env.SLACK_ALERT_WEBHOOK_URL;
  if (!url) return;
  try {
    await externalFetch({
      target: 'slack',
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: message }),
      timeoutMs: 15_000,
    });
  } catch (err) {
    log.warn({ error: err instanceof Error ? err.message : String(err) }, 'slack alert failed');
  }
}
