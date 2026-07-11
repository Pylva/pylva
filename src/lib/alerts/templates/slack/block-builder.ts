// B2a T4a — Slack Block Kit with deep-link actions. Truncates at 49 blocks
// so we never exceed Slack's 50-block cap (I-T4a-4).

import type { AlertPayload } from '@pylva/shared';
import { buildDashboardDeepLink } from '../../deep-link.js';

interface SectionBlock {
  type: 'section';
  text: { type: 'mrkdwn'; text: string };
  accessory?: ActionElement;
}
interface ContextBlock {
  type: 'context';
  elements: Array<{ type: 'mrkdwn'; text: string }>;
}
interface HeaderBlock {
  type: 'header';
  text: { type: 'plain_text'; text: string };
}
interface ActionsBlock {
  type: 'actions';
  elements: ActionElement[];
}
interface ActionElement {
  type: 'button';
  text: { type: 'plain_text'; text: string };
  url: string;
}

export type SlackBlock = SectionBlock | ContextBlock | HeaderBlock | ActionsBlock;

const MAX_BLOCKS = 50;

function escape(s: string): string {
  return s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
}

function buildOne(payload: AlertPayload): SlackBlock[] {
  const body = JSON.stringify(payload.payload.data, null, 2).slice(0, 2800);
  const url = buildDashboardDeepLink(payload.payload);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escape(payload.payload.type)}*\n\`\`\`\n${escape(body)}\n\`\`\``,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Investigate' },
        url,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `fired at ${escape(payload.fired_at)} · rule \`${escape(payload.rule_id)}\``,
        },
      ],
    },
  ];
}

export function buildAlertBlocks(payloads: AlertPayload[]): SlackBlock[] {
  if (payloads.length === 0) return [];
  const blocks: SlackBlock[] = [];

  if (payloads.length > 1) {
    blocks.push({
      type: 'header',
      text: { type: 'plain_text', text: `${payloads.length} Pylva alerts` },
    });
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: 'All fired in the last 60 seconds.' }],
    });
  }

  for (const p of payloads) {
    const next = buildOne(p);
    if (blocks.length + next.length > MAX_BLOCKS - 1) {
      const remaining = payloads.length - payloads.indexOf(p);
      blocks.push({
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `…and ${remaining} more alert${remaining === 1 ? '' : 's'} (truncated — see dashboard)`,
          },
        ],
      });
      break;
    }
    blocks.push(...next);
  }

  return blocks;
}
