#!/bin/sh
set -eu

JWT_KEY_DIR="${JWT_KEY_DIR:-/app/.keys}"
JWT_PRIVATE_KEY_PATH="${JWT_PRIVATE_KEY:-$JWT_KEY_DIR/private.pem}"
JWT_PUBLIC_KEY_PATH="${JWT_PUBLIC_KEY:-$JWT_KEY_DIR/public.pem}"

write_secret_file() {
  value="$1"
  path="$2"
  mode="$3"

  mkdir -p "$(dirname "$path")"
  (umask 077 && printf '%b\n' "$value" > "$path")
  chmod "$mode" "$path"
}

if [ -n "${JWT_PRIVATE_KEY_PEM:-}" ]; then
  write_secret_file "$JWT_PRIVATE_KEY_PEM" "$JWT_PRIVATE_KEY_PATH" 600
fi

if [ -n "${JWT_PUBLIC_KEY_PEM:-}" ]; then
  write_secret_file "$JWT_PUBLIC_KEY_PEM" "$JWT_PUBLIC_KEY_PATH" 644
fi

if [ ! -s "$JWT_PRIVATE_KEY_PATH" ]; then
  echo "Missing JWT private key. Set JWT_PRIVATE_KEY_PEM or mount JWT_PRIVATE_KEY." >&2
  exit 1
fi

if [ ! -s "$JWT_PUBLIC_KEY_PATH" ]; then
  echo "Missing JWT public key. Set JWT_PUBLIC_KEY_PEM or mount JWT_PUBLIC_KEY." >&2
  exit 1
fi

export JWT_PRIVATE_KEY="$JWT_PRIVATE_KEY_PATH"
export JWT_PUBLIC_KEY="$JWT_PUBLIC_KEY_PATH"

# ECS injects HOSTNAME at runtime, overriding the Dockerfile ENV and causing
# Next standalone to bind only the task hostname. Bind all interfaces so the
# ECS loopback liveness check and later ALB target checks can reach the app.
export HOSTNAME="${NEXT_BIND_HOST:-0.0.0.0}"

unset JWT_PRIVATE_KEY_PEM
unset JWT_PUBLIC_KEY_PEM

# DATABASE_URL assembly + urlencode() are shared with the Step 6 migration
# image (which has no Next.js runtime entrypoint) via docker-db-url.sh —
# single source of truth so the two images can't drift. Sourced here so the
# REDIS block below also gets urlencode(). REDIS_URL/CACHE_* stays app-only.
. /app/docker-db-url.sh

if [ -z "${REDIS_URL:-}" ] && [ -n "${CACHE_HOST:-}" ]; then
  if [ -z "${CACHE_AUTH_TOKEN:-}" ]; then
    echo "CACHE_HOST set but CACHE_AUTH_TOKEN empty — cache-auth secret injection failed?" >&2
    exit 1
  fi
  # rediss:// — ElastiCache Valkey transit encryption; AUTH token as password.
  _cache_auth="$(urlencode "$CACHE_AUTH_TOKEN")" || { echo "urlencode(CACHE_AUTH_TOKEN) failed (node)" >&2; exit 1; }
  if [ -n "${CACHE_USERNAME:-}" ]; then
    _cache_user="$(urlencode "$CACHE_USERNAME")" || { echo "urlencode(CACHE_USERNAME) failed (node)" >&2; exit 1; }
    export REDIS_URL="rediss://${_cache_user}:${_cache_auth}@${CACHE_HOST}:${CACHE_PORT:-6379}"
    unset _cache_user
  else
    export REDIS_URL="rediss://:${_cache_auth}@${CACHE_HOST}:${CACHE_PORT:-6379}"
  fi
  unset _cache_auth CACHE_AUTH_TOKEN CACHE_USERNAME
fi

exec "$@"
