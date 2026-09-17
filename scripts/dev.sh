#!/usr/bin/env bash
# Brings up local Postgres and Redis, then runs every app in watch mode.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="infra/docker/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is not on PATH. Start Docker Desktop, or bring up Postgres 16" >&2
  echo "and Redis 7 yourself and point DATABASE_URL and REDIS_URL at them." >&2
  exit 1
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "No .env found; copying .env.example"
  cp "$ROOT/.env.example" "$ROOT/.env"
fi

echo "Starting Postgres and Redis..."
# --wait blocks until both healthchecks pass, so migrations and apps do not
# race the database's first boot.
docker compose -f "$COMPOSE_FILE" up -d --wait

echo "Applying migrations..."
bash "$ROOT/scripts/db-migrate.sh"

echo "Starting apps in watch mode..."
exec pnpm turbo run dev
