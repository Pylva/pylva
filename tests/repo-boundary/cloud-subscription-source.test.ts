import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const internalCloudSubscriptionPaths = [
  'src/app/subscribe/[tier]',
  'src/app/o/[slug]/subscription',
  'src/app/api/v1/billing/subscription',
  'src/app/api/stripe/platform-webhooks',
  'src/app/api/cron/downgrade-lapsed-builders',
  'src/app/api/cron/dispatch-limit-notifications',
  'src/app/api/v1/admin/builders/[id]/tier',
  'src/lib/billing/downgrade-lapsed-builders.ts',
  'src/lib/billing/subscription-status.ts',
  'src/lib/billing/subscription-sync.ts',
  'src/lib/stripe/platform-client.ts',
  'src/lib/stripe/platform-webhook-handlers.ts',
  'src/lib/stripe/platform-webhook-public-handler.ts',
  'src/lib/limits/email.ts',
  'src/lib/limits/notifications.ts',
  'src/lib/pricing/catalog.ts',
  'src/components/dashboard/PastDueBanner.tsx',
  'src/components/dashboard/SubscriptionActions.tsx',
  'src/components/dashboard/SubscriptionUsageLine.tsx',
  'src/components/dashboard/TierBadge.tsx',
  'db/seed-stripe-price-map.ts',
  'scripts/verify-stripe-price-map.ts',
  'db/migrations/034_self_billing.sql',
  'db/migrations/038_stripe_platform_event_log_handled_at.sql',
  'db/migrations/045_stripe_price_tier_map_unique_enabled.sql',
  'db/migrations/046_tier_limit_notifications.sql',
  'tests/subscription',
  'tests/billing/subscription-status.test.ts',
  'tests/billing/checkout-race.test.ts',
  'tests/integration/subscription-routes.test.ts',
  'tests/integration/platform-webhook-redispatch.test.ts',
  'tests/integration/tier-limit-notifications.test.ts',
  'tests/frontend/subscription-actions.test.tsx',
  'tests/frontend/subscription-usage-line.test.tsx',
  'tests/frontend/pricing-catalog.test.ts',
  'tests/limits/email.test.ts',
  'tests/limits/notifications.test.ts',
  'tests/stripe/platform-webhook-db-failure.test.ts',
] as const;

const publicSelfHostFiles = [
  '.github/workflows/ci-fast.yml',
  '.github/workflows/ci-integration.yml',
  'src/lib/auth/tier-enforcement.ts',
  'src/lib/auth/post-auth-redirect.ts',
  'src/lib/db/schema.ts',
  'src/lib/db/migration-manifest.ts',
  'src/middleware.ts',
  'package.json',
  '.env.example',
] as const;

const forbiddenPublicTerms = [
  'SELF_SERVE_TIER_IDS',
  'STRIPE_PLATFORM_WEBHOOK_SECRET',
  'STRIPE_TEST_PRO_PRICE_ID',
  'STRIPE_TEST_SCALE_PRICE_ID',
  'ENABLE_SELF_BILLING',
  'ENABLE_TIER_ADMIN_OVERRIDE',
  'stripePriceTierMap',
  'stripePlatformEventLog',
  'builderSubscriptions',
  'tierLimitNotifications',
  'stripe:verify-price-map',
  'seed-stripe-price-map',
  'verify-stripe-price-map',
  '034_self_billing.sql',
  '038_stripe_platform_event_log_handled_at.sql',
  '045_stripe_price_tier_map_unique_enabled.sql',
  '046_tier_limit_notifications.sql',
] as const;

function exists(relativePath: string): boolean {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

function read(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

describe('Pylva Cloud subscription source boundary', () => {
  it('keeps hosted subscription, self-billing, and platform webhook source internal', () => {
    for (const relativePath of internalCloudSubscriptionPaths) {
      expect(exists(relativePath), `${relativePath} should live in pylva-internal`).toBe(false);
    }
  });

  it('keeps public self-host files free of hosted self-billing symbols and env knobs', () => {
    const violations: Array<{ file: string; term: string }> = [];

    for (const relativePath of publicSelfHostFiles) {
      const body = read(relativePath);
      for (const term of forbiddenPublicTerms) {
        if (body.includes(term)) {
          violations.push({ file: relativePath, term });
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps Pylva Cloud subscription routes out of auth, nav, and middleware', () => {
    expect(read('src/lib/auth/post-auth-redirect.ts')).not.toContain('/subscribe/');
    expect(read('src/components/dashboard/Sidebar.tsx')).not.toContain('/subscription');
    expect(read('src/middleware.ts')).not.toContain('/api/stripe/platform-webhooks');
  });
});
