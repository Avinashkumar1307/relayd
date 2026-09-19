#!/usr/bin/env bash
#
# Runs the database migrations as a one-off ECS task and waits for it to
# finish. Exits non-zero unless the container exited 0.
#
# CLAUDE.md section 8 and docs/10: migrations run as a one-off ECS task
# before the service update, never at container boot. Twenty tasks booting
# at once would race on the migration table, and a migration that fails at
# boot leaves a service that will not start with no clear reason why.
#
# This runs *before* the new image is deployed, which is what makes
# expand-then-contract load-bearing: for the duration of the deploy the new
# schema is live under the old code, so every migration must be compatible
# with the version already running (docs/10 "Migrations").
#
# Usage: migrate.sh <cluster> <family> <image> <network-source-service>
#
# The network configuration is copied from a running service rather than
# passed in, so the subnets and security group cannot drift out of sync with
# what Terraform actually created.

set -euo pipefail

cluster=${1:?usage: migrate.sh <cluster> <family> <image> <network-source-service>}
family=${2:?usage: migrate.sh <cluster> <family> <image> <network-source-service>}
image=${3:?usage: migrate.sh <cluster> <family> <image> <network-source-service>}
source_service=${4:?usage: migrate.sh <cluster> <family> <image> <network-source-service>}

here=$(cd "$(dirname "$0")" && pwd)

echo "==> Registering a migration revision on $image"
task_definition=$("$here/register-revision.sh" "$family" "$image")
echo "    $task_definition"

echo "==> Reading the network configuration from service $source_service"
network=$(aws ecs describe-services \
  --cluster "$cluster" \
  --services "$source_service" \
  --query 'services[0].networkConfiguration' \
  --output json)

if [ "$network" = "null" ] || [ -z "$network" ]; then
  echo "migrate: could not read a network configuration from $source_service" >&2
  exit 1
fi

echo "==> Running the migration task"
task_arn=$(aws ecs run-task \
  --cluster "$cluster" \
  --task-definition "$task_definition" \
  --launch-type FARGATE \
  --network-configuration "$network" \
  --started-by "deploy-migrate" \
  --query 'tasks[0].taskArn' \
  --output text)

if [ -z "$task_arn" ] || [ "$task_arn" = "None" ]; then
  echo "migrate: run-task returned no task; check the failures array above" >&2
  exit 1
fi

echo "    $task_arn"

# A migration that takes longer than this is either blocked on a lock or is
# rewriting a table it should not be rewriting, and either way a deploy
# hanging indefinitely is worse than one that fails and says so. The
# `lock_timeout = 5000` in the RDS parameter group means a blocked statement
# gives up long before this does.
echo "==> Waiting"
if ! aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"; then
  echo "migrate: the wait itself failed or timed out; the task may still be running" >&2
  echo "  Check: aws ecs describe-tasks --cluster $cluster --tasks $task_arn" >&2
  exit 1
fi

stopped=$(aws ecs describe-tasks \
  --cluster "$cluster" \
  --tasks "$task_arn" \
  --query 'tasks[0]' \
  --output json)

exit_code=$(printf '%s' "$stopped" | jq -r '.containers[0].exitCode // empty')
reason=$(printf '%s' "$stopped" | jq -r '.stoppedReason // "(none)"')

echo "==> Stopped: exit=${exit_code:-<none>} reason=$reason"

# An empty exit code is the case worth naming: the container never ran at
# all — an image that could not be pulled, a task that could not be placed —
# and `[ "" -eq 0 ]` would be a shell error rather than a clean failure.
if [ -z "$exit_code" ]; then
  echo "migrate: the container produced no exit code, so it never ran." >&2
  echo "  This is a pull, placement or role failure, not a migration failure." >&2
  exit 1
fi

if [ "$exit_code" -ne 0 ]; then
  echo "migrate: migrations failed with exit $exit_code. The services were not updated." >&2
  exit "$exit_code"
fi

echo "==> Migrations applied"
