#!/usr/bin/env bash
#
# Registers a new ECS task definition revision: the current one, with a
# different image. Echoes the new revision's ARN on stdout.
#
# Terraform owns the *shape* of a task definition — cpu, memory, roles,
# secrets, log configuration — and its `aws_ecs_service` carries
# `ignore_changes = [task_definition]`, so deploying is registering a
# revision here and pointing the service at it. That split keeps a deploy
# from needing `terraform apply`, and therefore from needing a Terraform
# state lock and an admin role on the deploy path.
#
# Everything except the image is copied from the live revision, so a change
# Terraform made yesterday is carried forward rather than reverted to
# whatever this script would have guessed.
#
# Usage: register-revision.sh <family> <image>

set -euo pipefail

family=${1:?usage: register-revision.sh <family> <image>}
image=${2:?usage: register-revision.sh <family> <image>}

# A tag is a moving pointer. docs/10: "Build once, promote the same image
# digest through staging to production. Never rebuild for production — a
# rebuilt image is a different artifact than the one you tested."
#
# The refusal is here, in the one place every deploy passes through, rather
# than in the workflow, so a future workflow cannot route around it.
case "$image" in
  *@sha256:*) ;;
  *)
    echo "register-revision: refusing '$image' — an image must be pinned by digest." >&2
    echo "  A tag can be repointed between the staging deploy and the production one," >&2
    echo "  which makes the artifact you approved and the artifact you shipped different." >&2
    exit 2
    ;;
esac

current=$(aws ecs describe-task-definition \
  --task-definition "$family" \
  --query 'taskDefinition' \
  --output json)

# The read-only fields come back from a describe and are rejected on a
# register, so they are dropped rather than passed through.
next=$(printf '%s' "$current" | jq --arg image "$image" '
  .containerDefinitions |= map(.image = $image)
  | del(
      .taskDefinitionArn,
      .revision,
      .status,
      .requiresAttributes,
      .compatibilities,
      .registeredAt,
      .registeredBy,
      .deregisteredAt
    )
')

# Assert the swap happened. A `jq` filter that silently matched nothing —
# a renamed field, a container list that came back empty — would otherwise
# register a revision still pointing at the old image, and the deploy would
# report success having shipped nothing.
swapped=$(printf '%s' "$next" | jq --arg image "$image" \
  '[.containerDefinitions[] | select(.image == $image)] | length')
total=$(printf '%s' "$next" | jq '.containerDefinitions | length')

if [ "$total" -eq 0 ] || [ "$swapped" -ne "$total" ]; then
  echo "register-revision: $swapped of $total containers got the new image; refusing." >&2
  exit 1
fi

printf '%s' "$next" |
  aws ecs register-task-definition \
    --cli-input-json file:///dev/stdin \
    --query 'taskDefinition.taskDefinitionArn' \
    --output text
