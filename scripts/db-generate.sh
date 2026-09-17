#!/usr/bin/env bash
# Generates SQL from the Drizzle schema. The output is then hand-edited and
# committed as an immutable numbered migration (docs/01).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/packages/db"

exec pnpm exec drizzle-kit generate
