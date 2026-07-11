// Regression: DLQ retry for the `email` channel double-wrapped the stored
// payload. The email channel persists the RAW AlertPayload[] in the DLQ
// `payload` column (exactly like slack — see deliverEmail's writeToDlq).
// sendEmailFromSnapshot, however, only coerced the single-AlertPayload and
// BatchedAlertPayload shapes and fell through to `[payload]` for everything
// else. An already-an-array payload therefore became `[ [AlertPayload, …] ]`;
// renderAlertEmail then read `.payload.type` off the inner array, threw, the
// try/catch turned it into `{ ok: false }`, and every email DLQ retry failed
// permanently — the alert could never be re-delivered (the email twin of the
// slack DLQ retry bug fixed in #229).
//
// The fix checks Array.isArray(payload) first so the production shape is
// handled, mirroring how the slack retry path treats row.payload as the raw
// array.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sendMock = vi.fn();
const renderAlertEmailMock = vi.fn();

// dlq-retry transitively imports logger + db/client (via db/rls), which read
// the validated env at module load. Stub config so the module graph loads
// without real env / DB connections; the email retry path under test only
// touches the mocked resend client + renderAlertEmail.
vi.mock('../../src/lib/config.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    RESEND_API_KEY: 're_test_key',
    ALERT_FROM_EMAIL: 'alerts@pylva.com',
  },
}));

// Mock the Resend SDK so getResend() returns a client without a network call.
vi.mock('resend', () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

// Mock the renderer so the assertion isolates the coercion wiring (does it
// pass the RAW array, not a double-wrapped `[ [..] ]`?) from HTML rendering.
vi.mock('../../src/lib/alerts/templates/email/alert.js', () => ({
  renderAlertEmail: renderAlertEmailMock,
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

function emailRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dlq-1',
    channel: 'email',
    webhook_config_id: null,
    event_type: 'rule.fired',
    payload: RAW_PAYLOADS as unknown as Record<string, unknown>,
    snapshot: { email_recipients: ['ops@example.com'] },
    attempts: 1,
    ...overrides,
  };
}

beforeEach(() => {
  sendMock.mockReset();
  renderAlertEmailMock.mockReset();
  renderAlertEmailMock.mockReturnValue({ subject: 'rendered', html: '<p>rendered</p>' });
  sendMock.mockResolvedValue({ data: { id: 'resend-1' }, error: null });
});

describe('DLQ email retry — payload shape', () => {
  it('renders the RAW AlertPayload[] (never a double-wrapped array) and sends', async () => {
    const result = await deliverFromSnapshot(emailRow());

    expect(result).toEqual({ ok: true });
    // The bug: renderAlertEmail was called with `[ [AlertPayload, …] ]`.
    // The fix: it receives the array exactly as stored.
    expect(renderAlertEmailMock).toHaveBeenCalledTimes(1);
    expect(renderAlertEmailMock).toHaveBeenCalledWith(RAW_PAYLOADS);

    const passed = renderAlertEmailMock.mock.calls[0]![0] as unknown[];
    expect(Array.isArray(passed[0])).toBe(false); // not double-wrapped
    expect((passed[0] as { payload: { type: string } }).payload.type).toBe(
      'cost_threshold_exceeded',
    );

    expect(sendMock).toHaveBeenCalledTimes(1);
    const sendArg = sendMock.mock.calls[0]![0] as { to: string[]; subject: string };
    expect(sendArg.to).toEqual(['ops@example.com']);
    expect(sendArg.subject).toBe('rendered');
  });

  it('surfaces a resend error as a retry failure', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'rate_limited' } });
    const result = await deliverFromSnapshot(emailRow());
    expect(result).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('fails closed when the frozen snapshot is missing recipients', async () => {
    const result = await deliverFromSnapshot(emailRow({ snapshot: {} }));
    expect(result).toEqual({ ok: false, error: 'snapshot_missing_email_recipients' });
    expect(sendMock).not.toHaveBeenCalled();
  });
});
