// B2a T3 — UTC period boundary helpers (D29: UTC internal, browser-TZ display).
// Used by both post-call evaluator (backend) + budget accumulator (SDK parity
// — see packages/sdk-ts/src/wrappers/_budget.ts for the equivalent).

import type { RulePeriod } from '@pylva/shared';

export function periodStartFor(period: RulePeriod, at: Date = new Date()): Date {
  const d = new Date(at.getTime());
  d.setUTCMilliseconds(0);
  d.setUTCSeconds(0);
  d.setUTCMinutes(0);
  if (period === 'hour') return d;
  d.setUTCHours(0);
  if (period === 'day') return d;
  if (period === 'week') {
    // ISO Monday-start week. UTCDay: 0 = Sunday, 1 = Monday, ...
    const dow = d.getUTCDay();
    const back = (dow + 6) % 7;
    d.setUTCDate(d.getUTCDate() - back);
    return d;
  }
  // month
  d.setUTCDate(1);
  return d;
}

export function periodEndFor(period: RulePeriod, at: Date = new Date()): Date {
  const start = periodStartFor(period, at);
  const end = new Date(start.getTime());
  switch (period) {
    case 'hour':
      end.setUTCHours(end.getUTCHours() + 1);
      break;
    case 'day':
      end.setUTCDate(end.getUTCDate() + 1);
      break;
    case 'week':
      end.setUTCDate(end.getUTCDate() + 7);
      break;
    case 'month':
      end.setUTCMonth(end.getUTCMonth() + 1);
      break;
  }
  return end;
}
