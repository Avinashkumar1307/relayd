#!/bin/sh
# Selects which process this container runs. One image, four roles
# (BUILD-PLAN Phase 0: "CMD selected by env var per process type").
#
# POSIX sh, not bash: the runtime image is node:22-alpine, which has no bash.
#
# Any explicit command overrides the selection, which is how the one-off
# migration task runs:
#   docker run ... relayd node packages/db/dist/bin/migrate.js
set -eu

if [ "$#" -gt 0 ]; then
  exec "$@"
fi

case "${RELAYD_PROCESS:-}" in
  api)       exec node apps/api/dist/index.js ;;
  edge)      exec node apps/edge/dist/index.js ;;
  worker)    exec node apps/worker/dist/index.js ;;
  scheduler) exec node apps/scheduler/dist/index.js ;;
  "")
    echo "RELAYD_PROCESS is not set. Expected one of: api, edge, worker, scheduler." >&2
    exit 1
    ;;
  *)
    echo "Unknown RELAYD_PROCESS: ${RELAYD_PROCESS}. Expected one of: api, edge, worker, scheduler." >&2
    exit 1
    ;;
esac
