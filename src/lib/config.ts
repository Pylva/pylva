// Primary validated environment configuration. The transport-only broker
// selector is independently validated in external-egress-config.ts so the
// minimal egress broker/canary does not require the full app environment.
// Decision #12: @t3-oss/env-core + Valibot
// B2a §4.7: adds OAuth / Resend / Sentry / Session / Cron env keys.

import { createEnv } from '@t3-oss/env-core';
import * as v from 'valibot';

const boolEnv = v.pipe(
  v.unknown(),
  v.transform((x) => (typeof x === 'string' ? x === 'true' : Boolean(x))),
  v.boolean(),
);

export const env = createEnv({
  server: {
    // --- PostgreSQL / ClickHouse / Redis ---
    DATABASE_URL: v.pipe(v.string(), v.minLength(1)),
    // ARN of the RDS-managed master user secret ({username,password}, auto-
    // rotated by AWS). When set (ECS/Lambda), the DB client fetches the current
    // password per connection so a rotation is picked up without a restart
    // (db/credentials.ts). Unset in local/dev/test → static DATABASE_URL.
    DB_MASTER_USER_SECRET_ARN: v.optional(v.string()),
    CLICKHOUSE_URL: v.pipe(v.string(), v.minLength(1)),
    REDIS_URL: v.pipe(v.string(), v.minLength(1)),

    // --- JWT keys (file paths; prod container writes PEM env values here) ---
    JWT_PRIVATE_KEY: v.pipe(v.string(), v.minLength(1)),
    JWT_PUBLIC_KEY: v.pipe(v.string(), v.minLength(1)),

    // --- argon2 pepper ---
    // minLength(1) keeps local/dev/test permissive; production strength (not the
    // dev default, >= 32 bytes) is enforced at boot by validateProductionSecrets
    // (config-guards.ts) so seeds/CLI/tests can still use the dev value.
    ARGON2_SECRET: v.pipe(v.string(), v.minLength(1)),
    // Dedicated HMAC key for OAuth `state` signing. Falls back to ARGON2_SECRET
    // when unset (back-compat); production should set a distinct >=32-byte value
    // so the OAuth-state and password-pepper trust domains are decoupled.
    OAUTH_STATE_SECRET: v.optional(v.pipe(v.string(), v.minLength(32))),

    // --- Node env ---
    NODE_ENV: v.optional(v.picklist(['development', 'production', 'test']), 'development'),

    // --- Stripe (B2b) ---
    STRIPE_SECRET_KEY: v.optional(v.string()),
    STRIPE_CONNECT_CLIENT_ID: v.optional(v.string()),
    // Webhook-signing secret for /api/v1/billing/webhooks. stripe CLI
    // supplies a `whsec_...` value; prod gets it from the Stripe dashboard.
    STRIPE_WEBHOOK_SECRET: v.optional(v.string()),
    // Pinned Stripe API version (e.g. "2024-11-20.acacia"). Prevents silent
    // behavior change when Stripe ships a new default version.
    STRIPE_API_VERSION: v.optional(v.string()),
    // USD only per B2b D15. Hard-coded default; column reserved for future
    // multi-currency work (deferred post-PMF).
    BILLING_DEFAULT_CURRENCY: v.optional(v.string(), 'usd'),

    // --- Logging ---
    LOG_LEVEL: v.optional(
      v.picklist(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']),
      'info',
    ),

    // --- Public backend URL ---
    PYLVA_BACKEND_URL: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:3000'),

    // --- Public site canonical URL ---
    // Used by product metadata, Stripe return URLs, OAuth callbacks, and auth
    // deep links. Defaults to localhost in dev; production must set it
    // explicitly (e.g. https://pylva.com).
    PUBLIC_SITE_URL: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:3000'),

    // --- Frontend launch: PostHog Cloud (analytics-only) ---
    NEXT_PUBLIC_POSTHOG_KEY: v.optional(v.string()),
    NEXT_PUBLIC_POSTHOG_HOST: v.optional(v.pipe(v.string(), v.url())),

    // Internal Slack drift / sync-failure webhook (B1 — team-notify helper;
    // NOT the user-facing Slack channel introduced in B2a).
    SLACK_ALERT_WEBHOOK_URL: v.optional(v.pipe(v.string(), v.url())),

    // Shared bearer for cron endpoint auth. B2a D1: EventBridge → ECS task.
    CRON_SECRET: v.optional(v.pipe(v.string(), v.minLength(32))),

    // --- B2a: OAuth (arctic) ---
    GOOGLE_OAUTH_CLIENT_ID: v.optional(v.string()),
    GOOGLE_OAUTH_CLIENT_SECRET: v.optional(v.string()),
    GITHUB_OAUTH_CLIENT_ID: v.optional(v.string()),
    GITHUB_OAUTH_CLIENT_SECRET: v.optional(v.string()),

    // Base URL used to construct OAuth redirect + invite links + alert deep
    // links. Must match the registered OAuth app's callback origin in prod.
    OAUTH_REDIRECT_BASE_URL: v.optional(v.pipe(v.string(), v.url()), 'http://localhost:3000'),

    // --- B2a: Email (Resend) ---
    RESEND_API_KEY: v.optional(v.string()),
    MAGIC_LINK_FROM_EMAIL: v.optional(v.pipe(v.string(), v.email()), 'login@pylva.local'),
    MAGIC_LINK_TTL_SECONDS: v.optional(
      v.pipe(
        v.unknown(),
        v.transform((x) => (typeof x === 'string' ? Number(x) : x)),
        v.number(),
        v.minValue(60),
        v.maxValue(3600),
      ),
      900,
    ),
    INVITE_FROM_EMAIL: v.optional(v.pipe(v.string(), v.email()), 'team@pylva.local'),
    // Recipient for the concierge custom-rule-request internal notification.
    // No default on purpose: unset (self-host) means the request is stored
    // locally and NOTHING is emailed to Pylva — preserving the "self-hosted
    // deployments send nothing to Pylva" guarantee. Pylva Cloud sets this.
    CUSTOM_RULE_REQUEST_EMAIL: v.optional(v.pipe(v.string(), v.email())),
    INVITE_TTL_HOURS: v.optional(
      v.pipe(
        v.unknown(),
        v.transform((x) => (typeof x === 'string' ? Number(x) : x)),
        v.number(),
        v.minValue(1),
        v.maxValue(720),
      ),
      168, // 7 days
    ),
    ALERT_FROM_EMAIL: v.optional(v.pipe(v.string(), v.email()), 'alerts@pylva.local'),

    // --- B2a: Sentry ---
    SENTRY_DSN: v.optional(v.string()),
    SENTRY_ENVIRONMENT: v.optional(v.picklist(['production', 'staging', 'dev']), 'dev'),
    // Build SHA baked at image build (Dockerfile ARG/ENV SENTRY_RELEASE).
    // Surfaced by /api/v1/health so a deploy can be checked against the
    // source SHA (verify-deploy skill). "unknown" in local/dev builds.
    SENTRY_RELEASE: v.optional(v.string(), 'unknown'),

    // --- B2a: Session cookies ---
    SESSION_COOKIE_NAME: v.optional(v.string(), 'pylva_session'),
    SESSION_COOKIE_SECURE: v.optional(boolEnv, true),

    // --- B3: Feature kill switches (D12) ---
    ENABLE_SIMULATOR: v.optional(boolEnv, true),
    ENABLE_SSE_FEED: v.optional(boolEnv, false),
    ENABLE_COST_SOURCES: v.optional(boolEnv, true),
    // Optional self-host event cap enforcement. Default OFF so local/self-host
    // builders are not limited by Pylva Cloud plan tiers.
    // Retention stamping is not behind this flag.
    ENABLE_EVENT_LIMITS: v.optional(boolEnv, false),

    // --- B4: Feature kill switches (b4 plan §3.6, D16) ---
    // Default false — features are dormant until operator opts in. Each flag
    // is independent so we can disable advanced rules without taking the
    // portal down (or vice versa).
    // Frontend launch §5: enable the product areas the public site sells.
    ENABLE_ADVANCED_RULES: v.optional(boolEnv, true),
    ENABLE_PORTAL: v.optional(boolEnv, true),
    ENABLE_PORTAL_OAUTH: v.optional(boolEnv, false),
    ENABLE_PORTAL_CUSTOM_DOMAINS: v.optional(boolEnv, false),
  },
  runtimeEnv: process.env,
});

export type Env = typeof env;
