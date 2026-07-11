// B2a — alert channel contract. Every channel impl (webhook/email/slack)
// exports a `deliver(payloads, entry)` fn matching this shape. Payloads is
// an array because the batcher may pass 1 or N; impls render accordingly.

import type { AlertChannelEntry, AlertPayload, DeliveryResult } from '@pylva/shared';

export interface ChannelDeliveryContext {
  builder_id: string;
  rule_id: string;
}

export type ChannelDeliverFn = (
  payloads: AlertPayload[],
  entry: AlertChannelEntry,
  ctx: ChannelDeliveryContext,
) => Promise<DeliveryResult>;
