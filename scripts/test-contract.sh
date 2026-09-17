#!/usr/bin/env bash
# The provider adapter contract suite: ~40 cases every adapter must pass,
# against recorded fixtures locally and sandbox accounts in CI (Phase 3).
#
# Convention: these live in *.contract.test.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COUNT=$(find apps packages -path '*/test/*' -name '*.contract.test.ts' 2>/dev/null | wc -l | tr -d '[:space:]')

if [[ "$COUNT" -eq 0 ]]; then
  echo "[test:contract] No contract tests yet."
  echo "[test:contract] The provider adapter contract suite lands in Phase 3 (BUILD-PLAN.md)."
  exit 0
fi

pnpm turbo run build
exec pnpm exec vitest run contract.test
