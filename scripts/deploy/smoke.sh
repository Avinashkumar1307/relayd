#!/usr/bin/env bash
#
# Smoke tests against a deployed environment.
#
# Usage: smoke.sh <base-url>            e.g. smoke.sh https://api.staging.relayd.io
#
# This runs against production as well as staging, so every check is
# read-only and unauthenticated. It creates no workspace, sends no email,
# and writes nothing a customer could see.
#
# What it is for: proving the deployed image is wired to its dependencies
# and that the routing in front of it points where it should. It is not a
# functional test suite — that is `pnpm test`, which has already passed on
# this digest before anything got deployed. A smoke test that duplicates the
# unit suite is slow and tells you nothing new; the checks worth making here
# are the ones that can only fail in a real environment.
#
# Each check names what a failure would mean, because the person reading
# this output is usually mid-incident.

set -euo pipefail

base=${1:?usage: smoke.sh <base-url>}
base=${base%/}

failures=0
checks=0

# `-sS` so curl is quiet but still reports transport errors, and an explicit
# timeout so a hung environment fails the deploy instead of the job's
# 6-hour default.
CURL=(curl -sS --max-time 15)

check() {
  local name=$1
  shift
  checks=$((checks + 1))

  if "$@"; then
    echo "  ok    $name"
  else
    echo "  FAIL  $name" >&2
    failures=$((failures + 1))
  fi
}

status_of() {
  "${CURL[@]}" -o /dev/null -w '%{http_code}' "$1"
}

expect_status() {
  local url=$1 want=$2 got
  got=$(status_of "$url") || return 1
  [ "$got" = "$want" ] || {
    echo "        $url -> $got, wanted $want" >&2
    return 1
  }
}

echo "==> Smoke tests against $base"

# --- the process is alive ------------------------------------------------
#
# `/health` never touches a dependency (docs/10), so this failing means the
# container is not running or the ALB is not routing to it. Nothing else.
check "/health responds" expect_status "$base/health" 200

# --- the process can reach what it needs ---------------------------------
#
# `/ready` is Postgres `SELECT 1` and Redis `PING`. This is the check that
# fails when a security group, a subnet route or a secret is wrong — which
# is to say, when the infrastructure changed. It is the single most useful
# line of output in this script.
check "/ready responds" expect_status "$base/ready" 200

# --- the correlation set is present --------------------------------------
#
# CLAUDE.md section 2: "One trace id from request → recipient → provider
# message id." If the response carries no request id then nothing logged
# during this deploy can be correlated, and the first incident is the wrong
# time to discover that.
check "responses carry a request id" bash -c '
  id=$("$@" -o /dev/null -D - "$0/health" 2>/dev/null | tr -d "\r" \
    | awk -F": " "tolower(\$1) == \"x-request-id\" { print \$2 }")
  test -n "$id"
' "$base" "${CURL[@]}"

# --- a garbage tracking token does not 500 -------------------------------
#
# docs/06: the pixel always returns a pixel. An invalid, expired or forged
# token is indistinguishable from a valid one to the recipient's mail
# client, and an error status here would leak which tokens are real.
check "an invalid tracking token still returns a pixel" expect_status \
  "$base/o/not-a-real-token.gif" 200

# --- unsubscribe by GET changes nothing ----------------------------------
#
# RFC 8058 and CLAUDE.md section 11: one-click unsubscribe acts on POST
# only. A GET renders a confirmation page. A scanner that follows every link
# in an email must not be able to unsubscribe the recipient, and that is
# exactly what a GET that acts would let it do.
#
# 200 for the confirmation page, or 404 for a token this environment has
# never issued. Anything else — a redirect, a 500 — means the route is doing
# something other than rendering.
check "unsubscribe GET renders rather than acts" bash -c '
  code=$("$@" -o /dev/null -w "%{http_code}" "$0/u/not-a-real-token")
  case "$code" in
    200|404) exit 0 ;;
    *) echo "        /u/<bad token> -> $code" >&2; exit 1 ;;
  esac
' "$base" "${CURL[@]}"

# --- the API refuses anonymous callers -----------------------------------
#
# The one check here that is about authorisation. If a deploy ever shipped
# with the auth middleware unmounted, every other check in this file would
# still pass.
check "the API rejects an unauthenticated request" bash -c '
  code=$("$@" -o /dev/null -w "%{http_code}" "$0/api/v1/workspaces")
  case "$code" in
    401|403) exit 0 ;;
    *) echo "        unauthenticated /api/v1/workspaces -> $code (wanted 401)" >&2; exit 1 ;;
  esac
' "$base" "${CURL[@]}"

# --- TLS terminates and HSTS is set --------------------------------------
check "HSTS is set" bash -c '
  "$@" -o /dev/null -D - "$0/health" 2>/dev/null | tr -d "\r" \
    | grep -qi "^strict-transport-security:"
' "$base" "${CURL[@]}"

echo
if [ "$failures" -gt 0 ]; then
  echo "==> $failures of $checks smoke checks failed against $base" >&2
  exit 1
fi

echo "==> $checks smoke checks passed against $base"
