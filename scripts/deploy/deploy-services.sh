#!/usr/bin/env bash
#
# Points every service at a new task definition revision built on the given
# image, then waits for all of them to reach a steady state.
#
# Usage: deploy-services.sh <cluster> <environment> <image> [service ...]
#
# With no service list it deploys the four process types in CLAUDE.md
# section 3. The order matters: `scheduler` last, because it is the
# singleton and its deployment settings stop the old task before starting
# the new one (minimum_healthy_percent = 0), so it is the one moment in a
# deploy when recurring work is not running. Doing it last keeps that window
# as short as possible and after everything else is already healthy.

set -euo pipefail

cluster=${1:?usage: deploy-services.sh <cluster> <environment> <image> [service ...]}
environment=${2:?usage: deploy-services.sh <cluster> <environment> <image> [service ...]}
image=${3:?usage: deploy-services.sh <cluster> <environment> <image> [service ...]}
shift 3

services=("$@")
if [ ${#services[@]} -eq 0 ]; then
  services=(api edge worker scheduler)
fi

here=$(cd "$(dirname "$0")" && pwd)

for service in "${services[@]}"; do
  family="relayd-${environment}-${service}"

  echo "==> $service"
  task_definition=$("$here/register-revision.sh" "$family" "$image")
  echo "    $task_definition"

  aws ecs update-service \
    --cluster "$cluster" \
    --service "$service" \
    --task-definition "$task_definition" \
    --no-cli-pager \
    --query 'service.serviceName' \
    --output text >/dev/null
done

# One wait for all of them rather than a wait per service, so a rolling
# deploy of four services takes the time of the slowest rather than the sum.
#
# `services-stable` polls for up to roughly 10 minutes before giving up. A
# service that has not stabilised by then is failing its health check and
# looping, and ECS's circuit breaker (enabled in the compute module) will
# have already begun rolling it back.
echo "==> Waiting for all services to stabilise"
if ! aws ecs wait services-stable --cluster "$cluster" --services "${services[@]}"; then
  echo "deploy-services: services did not stabilise." >&2
  echo "  The deployment circuit breaker rolls the failing service back on its own;" >&2
  echo "  this job fails so the pipeline does not go on to promote the digest." >&2

  for service in "${services[@]}"; do
    echo "--- $service ---" >&2
    aws ecs describe-services \
      --cluster "$cluster" \
      --services "$service" \
      --query 'services[0].events[0:5].message' \
      --output text >&2 || true
  done

  exit 1
fi

echo "==> All services stable on $image"
