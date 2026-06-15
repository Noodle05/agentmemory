#!/bin/sh
set -eu

DATA_DIR="${AGENTMEMORY_DATA_DIR:-/data}"
HMAC_FILE="${AGENTMEMORY_HMAC_FILE:-/data/.hmac}"

mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"

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

cat > /app/iii-config.yaml <<'EOF'
workers:
  - name: iii-http
    config:
      port: 3111
      host: 0.0.0.0
      default_timeout: 180000
      cors:
        allowed_origins:
          - "http://localhost:3111"
          - "http://localhost:3113"
          - "http://localhost:3114"
          - "http://127.0.0.1:3111"
          - "http://127.0.0.1:3113"
          - "http://127.0.0.1:3114"
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: 3112
      host: 0.0.0.0
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: /data/stream_store
  - name: iii-observability
    config:
      enabled: true
      service_name: agentmemory
      exporter: memory
      sampling_ratio: 0.1
      metrics_enabled: true
      logs_enabled: true
      logs_console_output: false
EOF

exec node /app/dist/index.mjs
