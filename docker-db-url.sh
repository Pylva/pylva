#!/bin/sh
# Shared DATABASE_URL assembly — sourced (not executed) by both
# docker-entrypoint.sh (Next.js runtime) and docker-migrate-entrypoint.sh
# (Step 6 one-off migration task). Single source of truth so the two images
# can't drift. Inherits `set -eu` from the caller; never `exec`s.
#
# Assemble DATABASE_URL from injected parts when not already set. ECS injects
# DB_* (plain) + the rotating RDS-managed master secret; reading them here
# means a rotated password is picked up on the next container start. Local/dev
# passes DATABASE_URL directly and skips this. node is always present (it runs
# the app / pnpm) — use it to URL-encode creds so special chars in a rotated
# password can't corrupt the connection string. Also defines urlencode() for
# the caller's other connection strings (e.g. REDIS_URL).
urlencode() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

if [ -z "${DATABASE_URL:-}" ] && [ -n "${DB_HOST:-}" ]; then
  # Fail fast with a clear reason if the RDS secret didn't inject (mirrors
  # the JWT block) — a silent empty password yields an opaque pool error.
  if [ -z "${DB_PASSWORD:-}" ]; then
    echo "DB_HOST set but DB_PASSWORD empty — RDS-managed secret injection failed?" >&2
    exit 1
  fi
  _db_user="$(urlencode "${DB_USERNAME:-pylva}")" || { echo "urlencode(DB_USERNAME) failed (node)" >&2; exit 1; }
  _db_pass="$(urlencode "$DB_PASSWORD")" || { echo "urlencode(DB_PASSWORD) failed (node)" >&2; exit 1; }
  # sslmode=require — RDS enforces rds.force_ssl=1 (core_stateful pg16 params).
  export DATABASE_URL="postgresql://${_db_user}:${_db_pass}@${DB_HOST}:${DB_PORT:-5432}/${DB_NAME:-pylva}?sslmode=require"
  unset _db_user _db_pass DB_PASSWORD DB_USERNAME
fi
