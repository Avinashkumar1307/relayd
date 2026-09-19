#!/usr/bin/env bash
#
# The quarterly timed restore drill (docs/runbooks/restore-drill.md).
#
# docs/10: "Restore drill — Quarterly, mandatory, timed. An untested backup
# is not a backup." The target is a verified, usable database inside the
# one-hour RTO.
#
# Usage:
#   restore-drill.sh plan
#   restore-drill.sh restore <iso-8601-utc> [--identifier NAME]
#   restore-drill.sh verify-config
#   restore-drill.sh verify-data
#   restore-drill.sh cleanup
#
# Environment: AWS_PROFILE, AWS_REGION, ENVIRONMENT (default staging).
#
# ## The one safety property
#
# Nothing here can touch the live instance. The restore always creates a new
# one — `restore-db-instance-to-point-in-time` has no in-place mode — and
# `cleanup` refuses any identifier without `-drill-` or `-recovery` in it.
# There is no override flag, because the override is what somebody reaches
# for at 3am when the real instance is the one they meant all along.

set -euo pipefail

ENVIRONMENT=${ENVIRONMENT:-staging}
SOURCE="relayd-${ENVIRONMENT}"
DRILL_ID="${SOURCE}-drill-$(date -u +%Y%m%d)"

command=${1:-}
shift || true

# ------------------------------------------------------------------ helpers

die() {
  echo "restore-drill: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is not installed"
}

require aws
require jq

instance() {
  aws rds describe-db-instances \
    --db-instance-identifier "$1" \
    --query 'DBInstances[0]' \
    --output json
}

# ------------------------------------------------------------------ plan

cmd_plan() {
  echo "==> Source: $SOURCE"
  local source
  source=$(instance "$SOURCE") || die "cannot read $SOURCE"

  printf '%s' "$source" | jq -r '
    "    engine              : \(.Engine) \(.EngineVersion)",
    "    class               : \(.DBInstanceClass)",
    "    multi-az            : \(.MultiAZ)",
    "    storage             : \(.AllocatedStorage) GB, encrypted=\(.StorageEncrypted)",
    "    backup retention    : \(.BackupRetentionPeriod) days",
    "    earliest restorable : \(.EarliestRestorableTime // "NONE")",
    "    latest restorable   : \(.LatestRestorableTime // "NONE")"
  '

  local earliest
  earliest=$(printf '%s' "$source" | jq -r '.EarliestRestorableTime // empty')

  if [ -z "$earliest" ]; then
    die "no restorable time — PITR is not available on $SOURCE. This is the finding."
  fi

  echo
  echo "==> Would create: $DRILL_ID"
  echo
  echo "    Pick a restore point inside the window above and run:"
  echo "      bash scripts/dr/restore-drill.sh restore '<iso-8601-utc>'"
}

# ------------------------------------------------------------------ restore

cmd_restore() {
  local point=${1:?usage: restore-drill.sh restore <iso-8601-utc> [--identifier NAME]}
  shift

  local target=$DRILL_ID
  if [ "${1:-}" = "--identifier" ]; then
    target=${2:?--identifier needs a name}
  fi

  # An identifier without a marker is how a drill becomes an outage. The
  # target is new either way — RDS refuses to create over an existing
  # identifier — but a name that looks like the live one is the start of the
  # mistake, not the end of it.
  case "$target" in
    *-drill-*|*-recovery*) ;;
    *) die "refusing target '$target': a restore target must contain -drill- or -recovery" ;;
  esac

  [ "$target" != "$SOURCE" ] || die "refusing to restore onto the source instance"

  local source
  source=$(instance "$SOURCE")

  echo "==> Restoring $SOURCE to $point"
  echo "    into $target"
  echo "    (the live instance is not modified)"

  aws rds restore-db-instance-to-point-in-time \
    --source-db-instance-identifier "$SOURCE" \
    --target-db-instance-identifier "$target" \
    --restore-time "$point" \
    --db-subnet-group-name "$(printf '%s' "$source" | jq -r '.DBSubnetGroup.DBSubnetGroupName')" \
    --vpc-security-group-ids "$(printf '%s' "$source" | jq -r '.VpcSecurityGroups[0].VpcSecurityGroupId')" \
    --db-parameter-group-name "$(printf '%s' "$source" | jq -r '.DBParameterGroups[0].DBParameterGroupName')" \
    --no-multi-az \
    --no-auto-minor-version-upgrade \
    --no-deletion-protection \
    --no-cli-pager \
    --query 'DBInstance.DBInstanceIdentifier' \
    --output text

  echo "==> Waiting for it to become available (this is the long pole)"
  local started
  started=$(date -u +%s)

  aws rds wait db-instance-available --db-instance-identifier "$target"

  local elapsed=$(( $(date -u +%s) - started ))
  echo "==> Available after ${elapsed}s ($((elapsed / 60))m)"
  echo
  echo "    Endpoint:"
  instance "$target" | jq -r '"      \(.Endpoint.Address):\(.Endpoint.Port)"'
  echo
  echo "    Next: bash scripts/dr/restore-drill.sh verify-data"
}

# ------------------------------------------------------- verify-config

cmd_verify_config() {
  # Against the LIVE instance. A drill that restores perfectly from a backup
  # policy quietly weakened last month proves less than it looks like.
  echo "==> Backup configuration on $SOURCE"

  local source failures=0
  source=$(instance "$SOURCE")

  local retention encrypted protection
  retention=$(printf '%s' "$source" | jq -r '.BackupRetentionPeriod')
  encrypted=$(printf '%s' "$source" | jq -r '.StorageEncrypted')
  protection=$(printf '%s' "$source" | jq -r '.DeletionProtection')

  local expected=7
  [ "$ENVIRONMENT" = "production" ] && expected=30

  # `label actual wanted [ge]`. Written out rather than as a one-liner
  # because `A || B && C` groups as `(A || B) && C` in the shell, and the
  # clever version silently fails every boolean check.
  check() {
    local label=$1 actual=$2 wanted=$3 mode=${4:-eq} ok=0

    if [ "$mode" = "ge" ]; then
      case "$actual" in
        ''|*[!0-9]*) ok=0 ;;
        *) [ "$actual" -ge "$wanted" ] && ok=1 ;;
      esac
    elif [ "$actual" = "$wanted" ]; then
      ok=1
    fi

    if [ "$ok" -eq 1 ]; then
      echo "  ok    $label ($actual)"
    else
      echo "  FAIL  $label: $actual, wanted $mode $wanted" >&2
      failures=$((failures + 1))
    fi
  }

  check "backup retention" "$retention" "$expected" ge
  check "storage encrypted" "$encrypted" "true"

  if [ "$ENVIRONMENT" = "production" ]; then
    check "deletion protection" "$protection" "true"
  fi

  # PITR window. Its absence is the finding the whole drill exists to catch.
  local earliest latest
  earliest=$(printf '%s' "$source" | jq -r '.EarliestRestorableTime // empty')
  latest=$(printf '%s' "$source" | jq -r '.LatestRestorableTime // empty')

  if [ -z "$earliest" ] || [ -z "$latest" ]; then
    echo "  FAIL  no PITR window — automated backups are off" >&2
    failures=$((failures + 1))
  else
    echo "  ok    PITR window $earliest .. $latest"
  fi

  # A cross-region copy, per docs/10 "Snapshot copies: daily cross-region".
  if [ -n "${DR_REGION:-}" ]; then
    local copies
    copies=$(aws rds describe-db-snapshots \
      --region "$DR_REGION" \
      --db-instance-identifier "$SOURCE" \
      --query 'length(DBSnapshots)' \
      --output text 2>/dev/null || echo 0)

    if [ "$copies" -gt 0 ]; then
      echo "  ok    $copies snapshot(s) in $DR_REGION"
    else
      echo "  FAIL  no snapshots in $DR_REGION — region loss is unrecoverable" >&2
      failures=$((failures + 1))
    fi
  else
    echo "  skip  cross-region copy (set DR_REGION to check)"
  fi

  [ "$failures" -eq 0 ] || die "$failures configuration check(s) failed"
  echo "==> Configuration verified"
}

# --------------------------------------------------------- verify-data

cmd_verify_data() {
  # A restored instance that accepts a connection is not a restored
  # database. PGHOST etc. point at the drill instance; the runbook says how.
  : "${PGHOST:?set PGHOST to the restored instance endpoint}"
  : "${PGDATABASE:=relayd}"
  export PGDATABASE

  require psql

  echo "==> Verifying the restored database at $PGHOST"
  local failures=0

  q() { psql -At -c "$1"; }

  # --- migrations ---
  local applied
  applied=$(q "select count(*) from _relayd_migrations")
  echo "  migrations applied: $applied"
  [ "$applied" -gt 0 ] || { echo "  FAIL  no migration rows" >&2; failures=$((failures + 1)); }

  # --- roles ---
  for role in relayd_app relayd_global; do
    if [ "$(q "select count(*) from pg_roles where rolname = '$role'")" = "1" ]; then
      echo "  ok    role $role"
    else
      echo "  FAIL  role $role missing" >&2
      failures=$((failures + 1))
    fi
  done

  # --- RLS ---
  #
  # The check that matters most and is easiest to skip. A restore brings
  # tables back; whether it brought the policies back is a different
  # question, and a database that returns everybody's rows to everybody is
  # worse than one that is down.
  local unprotected
  unprotected=$(q "
    select count(*)
    from pg_tables t
    join pg_class c on c.relname = t.tablename
    where t.schemaname = 'public'
      and exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = t.tablename
          and column_name = 'workspace_id'
      )
      and not c.relrowsecurity
  ")

  if [ "$unprotected" = "0" ]; then
    echo "  ok    RLS enabled on every tenant table"
  else
    echo "  FAIL  $unprotected tenant table(s) without RLS" >&2
    echo "        STOP. Do not trust this backup until this is understood." >&2
    failures=$((failures + 1))
  fi

  local policies
  policies=$(q "select count(*) from pg_policies where schemaname = 'public'")
  echo "  policies: $policies"
  [ "$policies" -gt 0 ] || { echo "  FAIL  no RLS policies" >&2; failures=$((failures + 1)); }

  # --- counters agree with rows ---
  #
  # CLAUDE.md section 12 bans COUNT(*) over campaign_recipients in a request
  # path. This is not a request path, and a counter that drifted through a
  # restore is exactly the kind of silent wrongness a drill is for.
  local drifted
  drifted=$(q "
    select count(*)
    from campaign_counters c
    where c.total <> (
      select count(*) from campaign_recipients r where r.campaign_id = c.campaign_id
    )
  " 2>/dev/null || echo 0)

  if [ "$drifted" = "0" ]; then
    echo "  ok    campaign_counters agree with campaign_recipients"
  else
    echo "  FAIL  $drifted campaign(s) with drifted counters" >&2
    failures=$((failures + 1))
  fi

  echo
  [ "$failures" -eq 0 ] || die "$failures data check(s) failed"
  echo "==> Data verified. Stop the stopwatch and record the time."
}

# ------------------------------------------------------------------ cleanup

cmd_cleanup() {
  local target=${1:-$DRILL_ID}

  # No override. The override is what somebody reaches for at 3am when the
  # live instance is the one they meant all along.
  case "$target" in
    *-drill-*) ;;
    *) die "refusing to delete '$target': only identifiers containing -drill- may be deleted" ;;
  esac

  echo "==> Deleting $target"
  aws rds delete-db-instance \
    --db-instance-identifier "$target" \
    --skip-final-snapshot \
    --delete-automated-backups \
    --no-cli-pager \
    --query 'DBInstance.DBInstanceStatus' \
    --output text

  echo "==> Deleting. It disappears in a few minutes; no need to wait."
}

# ------------------------------------------------------------------ dispatch

case "$command" in
  plan) cmd_plan ;;
  restore) cmd_restore "$@" ;;
  verify-config) cmd_verify_config ;;
  verify-data) cmd_verify_data ;;
  cleanup) cmd_cleanup "$@" ;;
  *)
    echo "usage: restore-drill.sh {plan|restore <iso-8601-utc>|verify-config|verify-data|cleanup}" >&2
    exit 2
    ;;
esac
