// B2a — backend alert framework type surface.
// Re-exports the shared types so channel/dispatch code imports from one place.

export type {
  AlertChannelEntry,
  RuleAlertChannelWebhook,
  RuleAlertChannelEmail,
  RuleAlertChannelSlack,
  AlertPayload,
  BatchedAlertPayload,
  DeliveryResult,
  DeliveryStatus,
  DeliveryStatusByChannel,
} from '@pylva/shared';

export { AlertDeliveryChannel } from '@pylva/shared';

// PendingBatch is an in-process type; never serialized on the wire.
export interface PendingBatch<Entry = unknown> {
  entry: Entry;
  payloads: import('@pylva/shared').AlertPayload[];
  timer: ReturnType<typeof setTimeout>;
  started_at: number;
}
