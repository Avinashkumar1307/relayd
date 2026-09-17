#!/usr/bin/env bash
# The six-part tenant-isolation suite (docs/06 section 15). Required CI check
# from Phase 1 onward.
#
# Convention: these live in *.isolation.test.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COUNT=$(find apps packages -path '*/test/*' -name '*.isolation.test.ts' 2>/dev/null | wc -l | tr -d '[:space:]')

if [[ "$COUNT" -eq 0 ]]; then
  echo "[test:isolation] No isolation tests yet."
  echo "[test:isolation] The six-part tenant-isolation suite lands in Phase 1 (BUILD-PLAN.md)."
  exit 0
fi

pnpm turbo run build
exec pnpm exec vitest run isolation.test
