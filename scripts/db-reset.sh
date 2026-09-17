#!/usr/bin/env bash
# Drops the local database, recreates it and migrates. LOCAL ONLY.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib/load-env.sh
. "$ROOT/scripts/lib/load-env.sh"
load_env_defaults "$ROOT/.env"

if [[ "${NODE_ENV:-development}" == "production" ]]; then
  echo "Refusing to reset a production database." >&2
  exit 1
fi

COMPOSE_FILE="infra/docker/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not on PATH; cannot reset the local database." >&2
  exit 1
fi

echo "Dropping and recreating the local database..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U relayd -d postgres -c 'DROP DATABASE IF EXISTS relayd WITH (FORCE);'
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  psql -U relayd -d postgres -c 'CREATE DATABASE relayd OWNER relayd;'

bash "$ROOT/scripts/db-migrate.sh"
echo "Local database reset."
