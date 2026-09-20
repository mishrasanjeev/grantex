#!/usr/bin/env bash
# Release test for cascade revocation and the emergency stop (PRD G-6): start
# the auth service against a real Postgres and Redis with the revocation feed
# on, measure how long a child grant keeps being authorised after its parent is
# revoked through both SDKs, then rehearse the emergency stop against running
# agents.
#
#   scripts/revocation-release-test.sh [trials]
#
# Settings:
#   RELEASE_PORT              port for the auth service (default 3199)
#   RELEASE_DATABASE_URL      Postgres to use (default: the container below)
#   RELEASE_REDIS_URL         Redis to use (default: the container below)
#   RELEASE_KEEP_CONTAINERS   1 to leave the containers running
#   RELEASE_SKIP_PYTHON       1 to run only the TypeScript measurement
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
trials="${1:-${REVOCATION_RELEASE_TRIALS:-10}}"
port="${RELEASE_PORT:-3199}"
pg_container="g6-release-pg"
redis_container="g6-release-redis"
pg_port="${RELEASE_PG_PORT:-55513}"
redis_port="${RELEASE_REDIS_PORT:-56513}"
database_url="${RELEASE_DATABASE_URL:-postgres://grantex_test:grantex_test@127.0.0.1:${pg_port}/grantex_test}"
redis_url="${RELEASE_REDIS_URL:-redis://127.0.0.1:${redis_port}}"
started_containers=0
service_pid=""
report_dir="$(mktemp -d)"

log() { printf '\n== %s\n' "$1"; }

cleanup() {
  if [[ -n "$service_pid" ]] && kill -0 "$service_pid" 2>/dev/null; then
    kill "$service_pid" 2>/dev/null || true
    wait "$service_pid" 2>/dev/null || true
  fi
  if [[ "$started_containers" == "1" && "${RELEASE_KEEP_CONTAINERS:-0}" != "1" ]]; then
    docker rm -f "$pg_container" "$redis_container" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

if [[ -z "${RELEASE_DATABASE_URL:-}" ]]; then
  log "starting Postgres and Redis"
  docker rm -f "$pg_container" "$redis_container" >/dev/null 2>&1 || true
  docker run -d --name "$pg_container" -p "127.0.0.1:${pg_port}:5432" \
    -e POSTGRES_USER=grantex_test -e POSTGRES_PASSWORD=grantex_test -e POSTGRES_DB=grantex_test \
    postgres:16-alpine >/dev/null
  docker run -d --name "$redis_container" -p "127.0.0.1:${redis_port}:6379" redis:7-alpine >/dev/null
  started_containers=1
  for _ in $(seq 1 60); do
    if docker exec "$pg_container" pg_isready -U grantex_test -d grantex_test >/dev/null 2>&1; then break; fi
    sleep 1
  done
fi

log "building the auth service"
npm --prefix "$root/apps/auth-service" ci --no-audit --no-fund >/dev/null
npm --prefix "$root/apps/auth-service" run build >/dev/null

log "starting the auth service on port ${port}"
(
  cd "$root/apps/auth-service"
  DATABASE_URL="$database_url" \
  REDIS_URL="$redis_url" \
  PORT="$port" \
  HOST=127.0.0.1 \
  NODE_ENV=development \
  AUTO_GENERATE_KEYS=true \
  JWT_ISSUER="http://127.0.0.1:${port}" \
  PUBLIC_BASE_URL="http://127.0.0.1:${port}" \
  VAULT_ENCRYPTION_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  ADMIN_API_KEY="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')" \
  REVOCATION_FEED_ENABLED=true   EMERGENCY_STOP_ENABLED=true \
  LOG_LEVEL=warn \
  node dist/index.js
) &
service_pid=$!

log "waiting for the auth service"
ready=0
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [[ "$ready" != "1" ]]; then
  echo "the auth service did not become healthy" >&2
  exit 1
fi

log "measuring with the TypeScript SDK (${trials} trials)"
npm --prefix "$root/packages/sdk-ts" run build >/dev/null
REVOCATION_RELEASE_BASE_URL="http://127.0.0.1:${port}" \
REVOCATION_RELEASE_TRIALS="$trials" \
REVOCATION_RELEASE_REPORT="${report_dir}/typescript.json" \
  npx --prefix "$root" vitest run --root "$root" tests/e2e/revocation-propagation.test.ts

log "rehearsing the emergency stop"
REVOCATION_RELEASE_BASE_URL="http://127.0.0.1:${port}" EMERGENCY_STOP_REPORT="${report_dir}/emergency-stop.json"   npx --prefix "$root" vitest run --root "$root" tests/e2e/emergency-stop.test.ts

if [[ "${RELEASE_SKIP_PYTHON:-0}" != "1" ]]; then
  log "measuring with the Python SDK (${trials} trials)"
  REVOCATION_RELEASE_BASE_URL="http://127.0.0.1:${port}" \
  REVOCATION_RELEASE_TRIALS="$trials" \
  REVOCATION_RELEASE_REPORT_PY="${report_dir}/python.json" \
    python "$root/tests/revocation_propagation.py"
fi

log "reports"
cat "${report_dir}"/*.json
