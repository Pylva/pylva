// B2a T4a — email alert template with deep-links + batched variant.
// Deep links embed slug (pending a slug lookup at delivery time) and
// customer_id so the recipient can click straight to the dashboard page.

import type { AlertPayload } from '@pylva/shared';
import { buildDashboardDeepLink } from '../../deep-link.js';

export interface RenderedEmail {
  subject: string;
  html: string;
}

const BATCH_SUBJECT = (count: number): string => `Pylva: ${count} alerts fired`;
const SINGLE_SUBJECT = (payload: AlertPayload): string => {
  const type = payload.payload.type.replace(/\./g, ' ').replace(/_/g, ' ');
  return `Pylva: ${type}`;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderOne(payload: AlertPayload): string {
  const type = escapeHtml(payload.payload.type);
  const firedAt = escapeHtml(payload.fired_at);
  const url = buildDashboardDeepLink(payload.payload);
  return `<div style="margin: 16px 0; padding: 16px; border: 1px solid #eee; border-radius: 8px;">
    <div style="font-weight:600; font-size: 14px;">${type}</div>
    <div style="color:#666;font-size:12px;margin-top:2px;">fired at ${firedAt}</div>
    <pre style="background:#f8f8fb;border-radius:6px;padding:12px;font-size:12px;overflow:auto;margin:12px 0 0 0;">${escapeHtml(JSON.stringify(payload.payload.data, null, 2))}</pre>
    <a href="${escapeHtml(url)}" style="display:inline-block;margin-top:12px;color:#004845;text-decoration:none;font-weight:500;font-size:13px">Investigate in dashboard →</a>
  </div>`;
}

export function renderAlertEmail(payloads: AlertPayload[]): RenderedEmail {
  const subject =
    payloads.length === 1 ? SINGLE_SUBJECT(payloads[0]!) : BATCH_SUBJECT(payloads.length);
  const body = payloads.map(renderOne).join('\n');
  const header =
    payloads.length > 1
      ? `<p style="font-size:13px;color:#444">${payloads.length} rules fired in the last 60 seconds. Each is listed below.</p>`
      : '';
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family: system-ui, -apple-system, sans-serif; color: #222; max-width: 560px; margin: 32px auto;">
  <h2 style="font-size:16px; margin: 0 0 12px 0;">${escapeHtml(subject)}</h2>
  ${header}
  ${body}
  <p style="color:#999; font-size:11px; margin-top: 32px;">Sent by Pylva. You're receiving this because your org has alert channels configured on a rule.</p>
</body></html>`;
  return { subject, html };
}
