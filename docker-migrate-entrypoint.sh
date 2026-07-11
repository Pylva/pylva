#!/bin/sh
set -eu

# Step 6 one-off migration entrypoint. The `migrations` Docker stage is
# FROM deps and has no Next.js runtime entrypoint; ECS injects the
# RDS-managed secret as DB_* parts (not a pre-assembled DATABASE_URL), and
# db/setup.ts silently falls back to localhost:5432 when DATABASE_URL is
# unset. Assemble it from the injected parts (shared logic), then run the
# command. No JWT / REDIS — `pnpm db:migrate` needs neither by default
# (`pnpm db:setup` remains valid as a command override; CLICKHOUSE_URL is
# injected directly from Secrets Manager when enable_clickhouse=true).
. /app/docker-db-url.sh

# A cleared command override would make `exec "$@"` a no-op → the task exits
# 0 having run zero migrations (silent success). Fail loud instead.
[ "$#" -gt 0 ] || { echo "docker-migrate-entrypoint: no command to exec (expected: pnpm db:migrate)" >&2; exit 1; }

exec "$@"
