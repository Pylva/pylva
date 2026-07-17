#!/bin/sh
# Assertions shared by runtime entrypoint phases. This script contains no
# secrets and never prints credential values.

assert_runtime_database_isolation() {
  if [ -n "${MIGRATION_DATABASE_URL:-}" ] ||
     [ -n "${MIGRATION_DB_HOST:-}" ] ||
     [ -n "${MIGRATION_DB_PORT:-}" ] ||
     [ -n "${MIGRATION_DB_NAME:-}" ] ||
     [ -n "${MIGRATION_DB_SSLMODE:-}" ] ||
     [ -n "${MIGRATION_DB_USERNAME:-}" ] ||
     [ -n "${MIGRATION_DB_PASSWORD:-}" ] ||
     [ -n "${MIGRATION_DB_MASTER_USER_SECRET_ARN:-}" ] ||
     [ -n "${MIGRATION_DB_RUNTIME_USER_SECRET_ARN:-}" ] ||
     [ -n "${MIGRATION_DATABASE_SECRET_ARN:-}" ]; then
    echo "Migration database credentials must never be injected into the Next.js runtime" >&2
    return 1
  fi

  if [ -n "${BUDGET_CONTROL_DATABASE_URL:-}" ] &&
     [ -n "${DATABASE_URL:-}" ] &&
     [ "$BUDGET_CONTROL_DATABASE_URL" = "$DATABASE_URL" ]; then
    echo "BUDGET_CONTROL_DATABASE_URL must not reuse DATABASE_URL in production" >&2
    return 1
  fi

  if [ -n "${BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN:-}" ] &&
     [ -n "${DB_MASTER_USER_SECRET_ARN:-}" ] &&
     [ "$BUDGET_CONTROL_DB_RUNTIME_USER_SECRET_ARN" = "$DB_MASTER_USER_SECRET_ARN" ]; then
    echo "Budget-control runtime credentials must not reuse the general database master secret" >&2
    return 1
  fi

  if [ -n "${BUDGET_PROJECTION_CLICKHOUSE_URL:-}" ] &&
     [ -n "${CLICKHOUSE_URL:-}" ] &&
     [ "$BUDGET_PROJECTION_CLICKHOUSE_URL" = "$CLICKHOUSE_URL" ]; then
    echo "BUDGET_PROJECTION_CLICKHOUSE_URL must not reuse CLICKHOUSE_URL in production" >&2
    return 1
  fi
}
