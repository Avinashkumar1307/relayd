#!/usr/bin/env bash
# The billing matrix against Stripe test mode (Phase 8).
#
# Without STRIPE_TEST_KEY this skips and exits 0, so a developer without
# Stripe credentials is not blocked. CI sets RELAYD_REQUIRE_BILLING_TESTS=1
# from Phase 8 onward, which turns the missing key into a failure — a billing
# suite that silently skips in CI is indistinguishable from one that passes.
#
# Convention: these live in *.billing.test.ts. They also run under the
# ordinary `pnpm test`, against the deterministic fake gateway docs/12 asks
# for; what the key adds is the Stripe-test-mode half — signature
# verification, real proration arithmetic, and the CLI replaying fixture
# events.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# shellcheck source=scripts/lib/load-env.sh
. "$ROOT/scripts/lib/load-env.sh"
load_env_defaults "$ROOT/.env"

if [[ -z "${STRIPE_TEST_KEY:-}" ]]; then
  if [[ "${RELAYD_REQUIRE_BILLING_TESTS:-}" == "1" ]]; then
    echo "STRIPE_TEST_KEY is not set and RELAYD_REQUIRE_BILLING_TESTS=1." >&2
    exit 1
  fi
  echo "SKIPPED: STRIPE_TEST_KEY not set"
  exit 0
fi

COUNT=$(find apps packages -path '*/test/*' -name '*.billing.test.ts' 2>/dev/null | wc -l | tr -d '[:space:]')

if [[ "$COUNT" -eq 0 ]]; then
  echo "[test:billing] No *.billing.test.ts files found." >&2
  exit 1
fi

pnpm turbo run build
exec pnpm exec vitest run billing.test
