#!/bin/sh
set -eu

# One-off migration entrypoint. Production injects a distinct object-owner /
# CREATEROLE credential as MIGRATION_DATABASE_URL or MIGRATION_DB_* parts.
# Runtime DATABASE_URL/DB_* and budget-control credentials are rejected by the
# sourced helper. No JWT / Redis credentials are needed.
. /app/docker-migration-db-url.sh

# A cleared command override would make `exec "$@"` a no-op → the task exits
# 0 having run zero migrations (silent success). Fail loud instead.
[ "$#" -gt 0 ] || { echo "docker-migrate-entrypoint: no command to exec (expected: pnpm db:migrate)" >&2; exit 1; }

exec "$@"
