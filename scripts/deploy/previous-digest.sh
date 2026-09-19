#!/usr/bin/env bash
#
# Prints the image digest a service ran *before* the one it is running now.
#
# docs/10: "Application rollback is redeploying the previous image digest,
# under 3 minutes." The three minutes are the reason this exists. Asking an
# operator to find a digest by hand, mid-incident, from a console they are
# not already logged into, is how a three-minute rollback becomes a
# twenty-minute one.
#
# Usage: previous-digest.sh <environment> [service]
#
# It reads the task definition revision history, which is the record ECS
# keeps whether or not our pipeline wrote anything down. A rollback that
# depended on a note the pipeline left behind would fail in exactly the case
# where the pipeline is what broke.

set -euo pipefail

environment=${1:?usage: previous-digest.sh <environment> [service]}
service=${2:-api}
family="relayd-${environment}-${service}"

# Newest first. 10 is enough to get past a run of revisions that all carry
# the same image — Terraform changing a memory limit registers a revision
# without changing the digest — while staying one API call.
revisions=$(aws ecs list-task-definitions \
  --family-prefix "$family" \
  --status ACTIVE \
  --sort DESC \
  --max-items 10 \
  --query 'taskDefinitionArns' \
  --output json)

count=$(printf '%s' "$revisions" | jq 'length')
if [ "$count" -lt 2 ]; then
  echo "previous-digest: $family has $count revision(s); there is nothing to roll back to." >&2
  exit 1
fi

image_of() {
  aws ecs describe-task-definition \
    --task-definition "$1" \
    --query 'taskDefinition.containerDefinitions[0].image' \
    --output text
}

current=$(image_of "$(printf '%s' "$revisions" | jq -r '.[0]')")

# The first *different* image, not simply the second revision. Two
# consecutive revisions often share a digest, and rolling back to the same
# image you are already running looks like a successful rollback and fixes
# nothing — the worst possible outcome during an incident, because it costs
# you the three minutes and tells you the rollback was not the problem.
for arn in $(printf '%s' "$revisions" | jq -r '.[1:][]'); do
  candidate=$(image_of "$arn")

  if [ "$candidate" != "$current" ]; then
    case "$candidate" in
      *@sha256:*)
        printf '%s\n' "$candidate"
        exit 0
        ;;
      *)
        echo "previous-digest: revision $arn carries '$candidate', which is not digest-pinned." >&2
        echo "  Refusing to roll back onto a tag; pass the digest explicitly." >&2
        exit 1
        ;;
    esac
  fi
done

echo "previous-digest: every recent revision of $family runs $current." >&2
echo "  There is no earlier image to roll back to within the last $count revisions." >&2
exit 1
