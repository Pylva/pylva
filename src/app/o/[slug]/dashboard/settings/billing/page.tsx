// SPDX-License-Identifier: Elastic-2.0
// B2b T2-E — settings/billing page. Shows Stripe connection status,
// Connect/Disconnect buttons, capabilities banner, and the builder-alert
// config form for payment_failed / dispute events.

import type { Metadata } from 'next';
import { eq } from 'drizzle-orm';
import { readDashboardHeaders } from '@/lib/dashboard/headers';
import { withRLS } from '@/lib/db/rls';
import { stripeConnect, builderAlertConfig } from '@/lib/db/schema';
import { StripeConnectStatus } from '@pylva/shared';
import { BuilderAlertConfigForm } from '@/components/billing/BuilderAlertConfigForm';
import { DashboardActionButton } from '@/components/dashboard/DashboardActionButton';

export const metadata: Metadata = { title: 'Billing' };

export default async function BillingSettingsPage() {
  const { builderId, role } = await readDashboardHeaders();

  const [connectRow, alertConfigRow] = await Promise.all([
    withRLS(builderId, async (tx) => {
      const rows = await tx
        .select({
          status: stripeConnect.status,
          capabilities_ok: stripeConnect.capabilities_ok,
          stripe_account_id: stripeConnect.stripe_account_id,
          connected_at: stripeConnect.connected_at,
        })
        .from(stripeConnect)
        .where(eq(stripeConnect.builder_id, builderId))
        .limit(1);
      return rows[0] ?? null;
    }),
    withRLS(builderId, async (tx) => {
      const rows = await tx
        .select({
          channel: builderAlertConfig.channel,
          enabled: builderAlertConfig.enabled,
          webhook_config_id: builderAlertConfig.webhook_config_id,
          email_recipients: builderAlertConfig.email_recipients,
          slack_webhook_url: builderAlertConfig.slack_webhook_url,
        })
        .from(builderAlertConfig)
        .where(eq(builderAlertConfig.builder_id, builderId))
        .limit(1);
      return rows[0] ?? null;
    }),
  ]);

  const status = connectRow?.status ?? StripeConnectStatus.NOT_CONNECTED;
  const isOwner = role === 'owner';

  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
      <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
        Connect Stripe to invoice your end-users and receive alerts on payment failures.
      </p>

      <section className="mt-8 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6">
        <h2 className="text-base font-semibold">Stripe Connect</h2>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          Status:{' '}
          <code className="rounded bg-[color:var(--muted)] px-1.5 py-0.5 text-xs">{status}</code>
        </p>
        {connectRow?.stripe_account_id ? (
          <p className="mt-2 text-xs text-[color:var(--muted-foreground)]">
            Account: <code>{connectRow.stripe_account_id}</code>
          </p>
        ) : null}

        {status === StripeConnectStatus.CONNECTED_PENDING_CAPABILITIES ? (
          <div className="mt-4 rounded border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm">
            Your Stripe onboarding is not complete. Stripe still needs card_payments +
            payouts_enabled before Pylva can generate invoices. Resume onboarding from your Stripe
            dashboard.
          </div>
        ) : null}

        <div className="mt-4 flex gap-2">
          {status === StripeConnectStatus.NOT_CONNECTED ||
          status === StripeConnectStatus.DISCONNECTED ? (
            <ConnectButton disabled={!isOwner} />
          ) : (
            <DisconnectButton disabled={!isOwner} />
          )}
        </div>
      </section>

      <section className="mt-6 rounded-lg border border-[color:var(--border)] bg-[color:var(--card)] p-6">
        <h2 className="text-base font-semibold">Payment-failure alerts</h2>
        <p className="mt-1 text-sm text-[color:var(--muted-foreground)]">
          Where to notify you when Stripe reports <code>invoice.payment_failed</code> or a dispute.
        </p>
        <BuilderAlertConfigForm initial={alertConfigRow} disabled={!isOwner} />
      </section>
    </>
  );
}

function ConnectButton({ disabled }: { disabled: boolean }) {
  return (
    <DashboardActionButton
      endpoint="/api/v1/billing/connect"
      label="Connect Stripe"
      disabled={disabled}
      redirectField="onboarding_url"
      className="rounded-md bg-[color:var(--primary)] px-4 py-2 text-sm text-[color:var(--primary-foreground)] disabled:opacity-50"
    />
  );
}

function DisconnectButton({ disabled }: { disabled: boolean }) {
  return (
    <DashboardActionButton
      endpoint="/api/v1/billing/disconnect"
      label="Disconnect Stripe"
      disabled={disabled}
      className="rounded-md border border-[color:var(--border)] px-4 py-2 text-sm disabled:opacity-50"
    />
  );
}
