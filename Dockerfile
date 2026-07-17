# syntax=docker/dockerfile:1

FROM node:26-bookworm-slim AS base

ENV NEXT_TELEMETRY_DISABLED=1 \
    PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global corepack@0.35.0 \
  && corepack enable

FROM base AS deps

# Copy only the workspace manifests first so `pnpm install` is cached until
# dependencies actually change — a source-only edit no longer busts this layer.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/ ./packages/
RUN pnpm install --frozen-lockfile

FROM deps AS builder

COPY . .

ARG PUBLIC_SITE_URL=http://localhost:3000
ARG OAUTH_REDIRECT_BASE_URL=http://localhost:3000
ARG PYLVA_BACKEND_URL=http://localhost:3000
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_SENTRY_RELEASE=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
ARG SENTRY_ENVIRONMENT=
ARG SENTRY_ORG=
ARG SENTRY_PROJECT=
ARG SENTRY_RELEASE=

# JWT_PRIVATE_KEY/JWT_PUBLIC_KEY are placeholder paths: src/lib/config.ts validates
# them as non-empty strings only; no file IO at build time. Runtime entrypoint writes
# the real PEMs from JWT_PRIVATE_KEY_PEM/JWT_PUBLIC_KEY_PEM into /app/.keys.
ENV ARGON2_SECRET=build-time-secret \
    CLICKHOUSE_URL=http://localhost:8123 \
    CRON_SECRET=12345678901234567890123456789012 \
    DATABASE_URL=postgresql://pylva:pylva@localhost:5432/pylva \
    JWT_PRIVATE_KEY=/tmp/build-private.pem \
    JWT_PUBLIC_KEY=/tmp/build-public.pem \
    REDIS_URL=redis://localhost:6379 \
    PUBLIC_SITE_URL=$PUBLIC_SITE_URL \
    OAUTH_REDIRECT_BASE_URL=$OAUTH_REDIRECT_BASE_URL \
    PYLVA_BACKEND_URL=$PYLVA_BACKEND_URL \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_SENTRY_ENVIRONMENT=$NEXT_PUBLIC_SENTRY_ENVIRONMENT \
    NEXT_PUBLIC_SENTRY_RELEASE=$NEXT_PUBLIC_SENTRY_RELEASE \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    SENTRY_ENVIRONMENT=$SENTRY_ENVIRONMENT \
    SENTRY_ORG=$SENTRY_ORG \
    SENTRY_PROJECT=$SENTRY_PROJECT \
    SENTRY_RELEASE=$SENTRY_RELEASE \
    SESSION_COOKIE_SECURE=false

RUN --mount=type=secret,id=sentry_auth_token,required=false \
  export SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
  && pnpm build

FROM deps AS migrations

# Step 6 migration runner. The Next.js standalone image intentionally omits
# db/ and pnpm; this target keeps the migration assets and package runner.
COPY db/ ./db/
COPY scripts/apply-postgres-migration.ts scripts/apply-postgres-migration-env.ts scripts/db-migrate.ts scripts/db-migrate-core.ts scripts/db-migrate-env.ts scripts/verify-physical-schema-contract.ts ./scripts/
COPY scripts/check-external-egress.ts ./scripts/
COPY src/lib/external-egress.ts src/lib/external-egress-config.ts src/lib/external-egress-core.ts src/lib/safe-error-metadata.ts ./src/lib/
COPY tsconfig.json ./
COPY docker-db-url.sh docker-migrate-entrypoint.sh ./
RUN chmod 755 /app/docker-migrate-entrypoint.sh /app/docker-db-url.sh

ENV NODE_ENV=production

# Assemble DATABASE_URL from the ECS-injected RDS secret parts before
# db:migrate. Use a command override for db:setup during fresh bootstraps.
ENTRYPOINT ["/app/docker-migrate-entrypoint.sh"]
CMD ["pnpm", "db:migrate"]

FROM node:26-bookworm-slim AS runner

# Bake the build SHA into the RUNTIME image. src/lib/config.ts reads
# process.env.SENTRY_RELEASE at runtime; /api/v1/health surfaces it and
# verify-deploy compares it to origin/main. Build args are per-stage, so this
# ARG must be re-declared here (it also exists in the builder stage). The ECS
# task definition no longer injects SENTRY_RELEASE — the baked per-image value
# is the single source of truth so deploys on a moving channel tag self-report
# the correct SHA.
ARG SENTRY_RELEASE=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
ENV HOSTNAME=0.0.0.0 \
    JWT_PRIVATE_KEY=/app/.keys/private.pem \
    JWT_PUBLIC_KEY=/app/.keys/public.pem \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY \
    NEXT_PUBLIC_POSTHOG_HOST=$NEXT_PUBLIC_POSTHOG_HOST \
    NODE_ENV=production \
    PORT=3000 \
    SENTRY_RELEASE=$SENTRY_RELEASE

WORKDIR /app

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs \
  && mkdir -p /app/.keys \
  && chown -R nextjs:nodejs /app

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --chown=nextjs:nodejs docker-entrypoint.sh docker-db-url.sh /app/

RUN chmod 755 /app/docker-entrypoint.sh /app/docker-db-url.sh

USER nextjs

EXPOSE 3000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
