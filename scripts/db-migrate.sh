#!/usr/bin/env bash
# Applies pending migrations. Idempotent: running it twice in a row applies
# nothing the second time and exits 0.
#
# Never run at container boot (CLAUDE.md section 12). In ECS this is a one-off
# task that completes before the service update begins.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Local convenience only; in ECS the task definition supplies the environment.
# shellcheck source=scripts/lib/load-env.sh
. "$ROOT/scripts/lib/load-env.sh"
load_env_defaults "$ROOT/.env"

exec pnpm exec tsx packages/db/src/bin/migrate.ts
