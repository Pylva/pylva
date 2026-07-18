#!/bin/sh
# Migration-task-only PostgreSQL credential assembly. This file is sourced by
# docker-migrate-entrypoint.sh and never copied into the Next.js runtime image.
# Production accepts only MIGRATION_DATABASE_URL or complete MIGRATION_DB_*
# parts. DATABASE_URL/DB_* fallback is deliberately limited to explicit local
# and CI use by scripts/migration-database-env.ts.

urlencode_migration_part() {
  node -e 'process.stdout.write(encodeURIComponent(process.argv[1] || ""))' "$1"
}

if [ "${NODE_ENV:-}" = "production" ] && {
  [ -n "${DATABASE_URL:-}" ] ||
  [ -n "${DB_HOST:-}" ] ||
  [ -n "${DB_PORT:-}" ] ||
  [ -n "${DB_NAME:-}" ] ||
  [ -n "${DB_USERNAME:-}" ] ||
  [ -n "${DB_PASSWORD:-}" ] ||
  [ -n "${DB_MASTER_USER_SECRET_ARN:-}" ] ||
  [ -n "${DB_RUNTIME_USER_SECRET_ARN:-}" ] ||
  [ -n "${BUDGET_CONTROL_DATABASE_URL:-}" ] ||
  [ -n "${BUDGET_CONTROL_DB_HOST:-}" ] ||
  [ -n "${BUDGET_CONTROL_DB_PORT:-}" ] ||
  [ -n "${BUDGET_CONTROL_DB_NAME:-}" ] ||
  [ -n "${BUDGET_CONTROL_DB_USERNAME:-}" ] ||
  [ -n "${BUDGET_CONTROL_DB_PASSWORD:-}" ] ||
  [ -n "${BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN:-}" ];
}; then
  echo "Production migration task received runtime database credentials; inject only MIGRATION_DATABASE_URL or MIGRATION_DB_*" >&2
  exit 1
fi

if [ -n "${MIGRATION_DATABASE_URL:-}" ] && {
  [ -n "${MIGRATION_DB_HOST:-}" ] ||
  [ -n "${MIGRATION_DB_PORT:-}" ] ||
  [ -n "${MIGRATION_DB_NAME:-}" ] ||
  [ -n "${MIGRATION_DB_SSLMODE:-}" ] ||
  [ -n "${MIGRATION_DB_USERNAME:-}" ] ||
  [ -n "${MIGRATION_DB_PASSWORD:-}" ];
}; then
  echo "Set either MIGRATION_DATABASE_URL or MIGRATION_DB_* parts, not both" >&2
  exit 1
fi

if [ -z "${MIGRATION_DATABASE_URL:-}" ] && [ -n "${MIGRATION_DB_HOST:-}" ]; then
  if [ -z "${MIGRATION_DB_USERNAME:-}" ] || [ -z "${MIGRATION_DB_PASSWORD:-}" ]; then
    echo "MIGRATION_DB_HOST requires non-empty MIGRATION_DB_USERNAME and MIGRATION_DB_PASSWORD" >&2
    exit 1
  fi
  _migration_user="$(urlencode_migration_part "$MIGRATION_DB_USERNAME")" || {
    echo "urlencode(MIGRATION_DB_USERNAME) failed (node)" >&2
    exit 1
  }
  _migration_pass="$(urlencode_migration_part "$MIGRATION_DB_PASSWORD")" || {
    echo "urlencode(MIGRATION_DB_PASSWORD) failed (node)" >&2
    exit 1
  }
  export MIGRATION_DATABASE_URL="postgresql://${_migration_user}:${_migration_pass}@${MIGRATION_DB_HOST}:${MIGRATION_DB_PORT:-5432}/${MIGRATION_DB_NAME:-pylva}?sslmode=${MIGRATION_DB_SSLMODE:-require}"
  unset _migration_user _migration_pass MIGRATION_DB_PASSWORD MIGRATION_DB_USERNAME
fi

if [ "${NODE_ENV:-}" = "production" ] && [ -z "${MIGRATION_DATABASE_URL:-}" ]; then
  echo "Production migration task requires MIGRATION_DATABASE_URL or MIGRATION_DB_*" >&2
  exit 1
fi
