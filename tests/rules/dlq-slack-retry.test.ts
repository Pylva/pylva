// Regression: DLQ retry for the `slack` channel was posting the stored
// AlertPayload[] verbatim (`JSON.stringify(row.payload)`), i.e. a bare JSON
// array. Slack's Incoming Webhook API requires a top-level `blocks`/`text`
// field and rejects a bare array with 400 invalid_payload, so every slack
// retry failed permanently and the alert could never be re-delivered.
//
// The slack channel stores the RAW payload in the DLQ (like email), so the
// retry path must re-render Block Kit via buildAlertBlocks and post
// `{ blocks }` — exactly as the live deliverSlack path does.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const externalFetchMock = vi.fn();
const buildAlertBlocksMock = vi.fn();

// dlq-retry transitively imports logger + db/client (via db/rls), which read
// the validated env at module load. Stub config so the module graph loads
// without real env / DB connections; deliverFromSnapshot under test only
// touches the mocked externalFetch + block-builder.
vi.mock('../../src/lib/config.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
  },
}));

vi.mock('../../src/lib/external-egress.js', () => ({
  externalFetch: externalFetchMock,
}));

// Mock the renderer so the assertion isolates the retry wiring (does it wrap
// in { blocks }?) from the Block Kit rendering details + env-dependent
// deep-link construction.
vi.mock('../../src/lib/alerts/templates/slack/block-builder.js', () => ({
  buildAlertBlocks: buildAlertBlocksMock,
}));

const { deliverFromSnapshot } = await import('../../src/lib/alerts/dlq-retry.js');

const RAW_PAYLOADS = [
  {
    version: '1.0',
    rule_id: 'rule-1',
    fired_at: '2026-06-14T00:00:00.000Z',
    payload: {
      id: 'evt-1',
      type: 'cost_threshold_exceeded',
      builder_id: 'b1',
      timestamp: '2026-06-14T00:00:00.000Z',
      data: {
        customer_id: 'cust-1',
        threshold_usd: 100,
        current_usd: 150,
        period: 'month',
        rule_id: 'rule-1',
      },
    },
  },
];

const SENTINEL_BLOCKS = [{ type: 'header', text: { type: 'plain_text', text: 'rendered' } }];

function slackRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq-1',
    channel: 'slack',
    webhook_config_id: null,
    event_type: 'rule.fired',
    payload: RAW_PAYLOADS as unknown as Record<string, unknown>,
    snapshot: { slack_webhook_url: 'https://hooks.slack.com/services/T/B/X' },
    attempts: 1,
    ...overrides,
  };
}

beforeEach(() => {
  externalFetchMock.mockReset();
  buildAlertBlocksMock.mockReset();
  buildAlertBlocksMock.mockReturnValue(SENTINEL_BLOCKS);
  externalFetchMock.mockResolvedValue({ status: 200, statusText: 'OK', headers: {}, body: '' });
});

describe('DLQ slack retry — payload shape', () => {
  it('re-renders Block Kit and posts a top-level { blocks } object, never the raw array', async () => {
    const result = await deliverFromSnapshot(slackRow());

    expect(result).toEqual({ ok: true });
    expect(buildAlertBlocksMock).toHaveBeenCalledWith(RAW_PAYLOADS);
    expect(externalFetchMock).toHaveBeenCalledTimes(1);

    const req = externalFetchMock.mock.calls[0]![0] as {
      target: string;
      url: string;
      body: string;
    };
    expect(req.target).toBe('slack');
    expect(req.url).toBe('https://hooks.slack.com/services/T/B/X');

    const sent = JSON.parse(req.body);
    // The bug: a bare array. The fix: an object with `blocks`.
    expect(Array.isArray(sent)).toBe(false);
    expect(sent).toEqual({ blocks: SENTINEL_BLOCKS });
  });

  it('surfaces a non-2xx slack response as a retry failure', async () => {
    externalFetchMock.mockResolvedValue({
      status: 400,
      statusText: 'Bad Request',
      headers: {},
      body: 'invalid_payload',
    });

    const result = await deliverFromSnapshot(slackRow());
    expect(result).toEqual({ ok: false, error: 'slack 400' });
  });

  it('fails closed when the frozen snapshot is missing the webhook url', async () => {
    const result = await deliverFromSnapshot(slackRow({ snapshot: {} }));
    expect(result).toEqual({ ok: false, error: 'snapshot_missing_slack_url' });
    expect(externalFetchMock).not.toHaveBeenCalled();
  });
});
