#!/usr/bin/env bash
# Loads .env as DEFAULTS, never as overrides.
#
# The previous form was `set -a; . .env; set +a`, which lets a dotfile silently
# beat a variable the caller passed explicitly. That is the wrong precedence:
#   DATABASE_URL=postgres://staging/... pnpm db:migrate
# would have migrated whatever .env pointed at instead, which for a migration
# runner is a genuinely bad way to find out.
#
# An already-set, non-empty variable always wins.
load_env_defaults() {
  local file="$1"
  [[ -f "$file" ]] || return 0

  local line key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"                       # tolerate a CRLF .env
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^[[:space:]]*$ ]] && continue
    [[ "$line" != *=* ]] && continue

    key="${line%%=*}"
    key="${key#"${key%%[![:space:]]*}"}"       # trim leading space
    key="${key%"${key##*[![:space:]]}"}"       # trim trailing space
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    [[ -n "${!key:-}" ]] && continue           # explicit value wins

    value="${line#*=}"
    export "${key}=${value}"
  done < "$file"
}
