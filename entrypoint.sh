#!/bin/sh
set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
HMAC_FILE="${AGENTMEMORY_HMAC_FILE:-/data/.hmac}"

mkdir -p "$DATA_DIR"

if [ ! -s "$HMAC_FILE" ]; then
  SECRET="$(openssl rand -hex 32)"
  umask 077
  printf '%s\n' "$SECRET" > "$HMAC_FILE"
  chmod 600 "$HMAC_FILE"
  chown node:node "$HMAC_FILE"
  echo "Generated new AGENTMEMORY_SECRET"
fi

if [ -z "${AGENTMEMORY_SECRET_FILE:-}" ]; then
  export AGENTMEMORY_SECRET_FILE="$HMAC_FILE"
fi

if [ -z "${AGENTMEMORY_SECRET:-}" ]; then
  export AGENTMEMORY_SECRET="$(cat "$HMAC_FILE")"
fi

exec node /app/dist/index.mjs
