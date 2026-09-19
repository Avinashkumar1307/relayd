"""Negative controls for complaint monitoring and the enforcement ladder.

Covers:
  packages/campaigns/test/enforcement.test.ts
  packages/campaigns/test/enforcement-sweep.test.ts
  packages/campaigns/test/launch.test.ts
  apps/api/test/campaigns.test.ts

docs/06 puts this row in the section titled "the section that keeps the
business alive". Every mutation below is a way the ladder stops working
while the dashboard still shows a stage next to each workspace.

Run: python3 .nc/nc_enforcement.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = [
    "packages/campaigns/test/enforcement.test.ts",
    "packages/campaigns/test/enforcement-sweep.test.ts",
    "packages/campaigns/test/launch.test.ts",
    "apps/api/test/campaigns.test.ts",
]

POLICY = ROOT / "packages/campaigns/src/abuse/enforcement.ts"
SWEEP = ROOT / "packages/campaigns/src/abuse/sweep.ts"
LAUNCH = ROOT / "packages/campaigns/src/engine/launch.ts"
SERVICE = ROOT / "apps/api/src/services/campaigns.ts"

BUILD_AFTER = {POLICY, SWEEP, LAUNCH}

# (file, description, old, new)
MUTATIONS = [
    # --- the thresholds -------------------------------------------------
    (POLICY, "the pause threshold is raised out of usefulness",
     "export const COMPLAINT_PAUSE_RATE = 0.003;",
     "export const COMPLAINT_PAUSE_RATE = 0.3;"),
    (POLICY, "the review threshold disappears",
     "export const COMPLAINT_REVIEW_RATE = 0.001;",
     "export const COMPLAINT_REVIEW_RATE = 0.003;"),
    (POLICY, "the bounce threshold is raised past docs/06",
     "export const BOUNCE_HYGIENE_RATE = 0.05;",
     "export const BOUNCE_HYGIENE_RATE = 0.5;"),
    (POLICY, "the threshold fires at the number rather than above it",
     "  if (complaintRate(metrics) > COMPLAINT_PAUSE_RATE) return 'complaint_rate_pause';",
     "  if (complaintRate(metrics) >= COMPLAINT_PAUSE_RATE) return 'complaint_rate_pause';"),
    # --- the sample floor -----------------------------------------------
    (POLICY, "the sample floor is removed, so one complaint pauses a workspace",
     "  if (!hasEnoughSample(metrics)) return 'clean';", ""),
    (POLICY, "the sample floor is raised so high nothing is ever assessed",
     "export const MIN_SAMPLE = 500;", "export const MIN_SAMPLE = 5_000_000;"),
    (POLICY, "the sample floor is off by one and rejects a legal sample",
     "  return metrics.sent >= MIN_SAMPLE;", "  return metrics.sent > MIN_SAMPLE;"),
    # --- precedence -----------------------------------------------------
    (POLICY, "bounces outrank complaints, so a spammer is asked to tidy up",
     "  if (complaintRate(metrics) > COMPLAINT_PAUSE_RATE) return 'complaint_rate_pause';\n"
     "  if (complaintRate(metrics) > COMPLAINT_REVIEW_RATE) return 'complaint_rate_review';\n"
     "  if (hardBounceRate(metrics) > BOUNCE_HYGIENE_RATE) return 'bounce_rate_hygiene';",
     "  if (hardBounceRate(metrics) > BOUNCE_HYGIENE_RATE) return 'bounce_rate_hygiene';\n"
     "  if (complaintRate(metrics) > COMPLAINT_PAUSE_RATE) return 'complaint_rate_pause';\n"
     "  if (complaintRate(metrics) > COMPLAINT_REVIEW_RATE) return 'complaint_rate_review';"),
    # --- the ladder's shape ---------------------------------------------
    (POLICY, "automation is allowed to suspend a workspace",
     "  'paused',\n];", "  'paused',\n  'suspended',\n];"),
    (POLICY, "a warning stops sending, collapsing the ladder",
     "export function maySend(stage: EnforcementStage): boolean {\n"
     "  return stageRank(stage) < stageRank('paused');",
     "export function maySend(stage: EnforcementStage): boolean {\n"
     "  return stageRank(stage) < stageRank('warned');"),
    (POLICY, "review stops sending, making it a second name for paused",
     "export function mayLaunch(stage: EnforcementStage): boolean {\n"
     "  return stageRank(stage) < stageRank('paused');",
     "export function mayLaunch(stage: EnforcementStage): boolean {\n"
     "  return stageRank(stage) < stageRank('review_required');"),
    # --- release --------------------------------------------------------
    (POLICY, "the ladder only ever climbs",
     "  const next = STAGES[stageRank(state.stage) - 1];",
     "  const next = state.stage;"),
    (POLICY, "a paused workspace is released straight to clean",
     "  const next = STAGES[stageRank(state.stage) - 1];",
     "  const next = 'none' as const;"),
    (POLICY, "release happens immediately, with no clean period",
     "  if (cleanFor < RECOVERY_DAYS * 86_400_000) return { action: 'none' };",
     "  if (cleanFor < 0) return { action: 'none' };"),
    (POLICY, "the recovery period is a day rather than a fortnight",
     "export const RECOVERY_DAYS = 14;", "export const RECOVERY_DAYS = 1;"),
    # --- operator holds -------------------------------------------------
    (POLICY, "a nightly job overrides an operator's hold",
     "  if (state.heldByOperator) return { action: 'none' };", ""),
    (POLICY, "automation lifts a suspension",
     "  if (!isAutomatic(state.stage)) return { action: 'none' };", ""),
    # --- the sweep ------------------------------------------------------
    (SWEEP, "workspaces already under enforcement are never reassessed",
     "  const flagged = await port.workspacesUnderEnforcement();",
     "  const flagged: Awaited<ReturnType<typeof port.workspacesUnderEnforcement>> = [];"),
    (SWEEP, "a fresh state overwrites the recorded one",
     "    if (!states.has(workspaceId)) {\n"
     "      states.set(workspaceId, { stage: 'none', enteredAt: now, heldByOperator: false });\n"
     "    }",
     "    states.set(workspaceId, { stage: 'none', enteredAt: now, heldByOperator: false });"),
    (SWEEP, "one workspace's bad data stops the whole sweep",
     "      result.failed.push(workspaceId);\n      continue;",
     "      result.failed.push(workspaceId);\n      throw new Error('sweep aborted');"),
    (SWEEP, "the escalation ceiling is removed",
     "    if (decision.action === 'escalate' && result.escalated >= options.maxEscalationsPerRun) {",
     "    if (false) {"),
    (SWEEP, "hitting the ceiling also strands workspaces waiting for release",
     "    if (decision.action === 'escalate' && result.escalated >= options.maxEscalationsPerRun) {",
     "    if (result.escalated >= options.maxEscalationsPerRun) {"),
    (SWEEP, "a no-op write still emails the customer",
     "    if (!changed) {\n      result.skipped += 1;\n      continue;\n    }",
     "    if (!changed) {\n      result.skipped += 1;\n    }"),
    (SWEEP, "enforcement actions are applied without an audit row",
     "    await port.recordAction({ workspaceId, from: state.stage, to, reason, rate });", ""),
    (SWEEP, "the customer is never told",
     "    await port.notify({ workspaceId, stage: to, reason, rate });", ""),
    (SWEEP, "the metrics window differs from the traffic window",
     "      const metrics = await port.metricsFor(workspaceId, options.windowDays);",
     "      const metrics = await port.metricsFor(workspaceId, 7);"),
    # --- the launch gate ------------------------------------------------
    (LAUNCH, "a paused workspace may launch",
     "  if (!mayLaunch(stage)) {", "  if (!mayLaunch(stage) && stage === 'terminated') {"),
    (LAUNCH, "review no longer needs approval",
     "  if (needsReview(stage) && !(await port.launchIsApproved(campaignId))) {",
     "  if (!needsReview(stage) && !(await port.launchIsApproved(campaignId))) {"),
    (LAUNCH, "approval is ignored, so review is a permanent block",
     "  if (needsReview(stage) && !(await port.launchIsApproved(campaignId))) {",
     "  if (needsReview(stage)) {"),
    (LAUNCH, "the stage read is discarded and everybody reads as clean",
     "  const stage = await port.readEnforcementStage(campaign.workspaceId);",
     "  const stage: EnforcementStage =\n"
     "    (await port.readEnforcementStage(campaign.workspaceId)) === 'terminated'\n"
     "      ? 'terminated'\n"
     "      : 'none';"),
    # --- the API status -------------------------------------------------
    (SERVICE, "a paused account reads as a malformed request",
     "  enforcement_paused: 403,", "  enforcement_paused: 422,"),
]


def build() -> bool:
    result = subprocess.run(
        ["pnpm", "turbo", "run", "build", "--filter=@relayd/campaigns"],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", shell=True, timeout=900,
    )
    return result.returncode == 0


def run_suites() -> bool:
    result = subprocess.run(
        ["node", "node_modules/vitest/vitest.mjs", "run", *SUITES, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=1800,
    )
    return result.returncode == 0


def main() -> int:
    if not build():
        print("BASELINE BUILD FAILS")
        return 1

    if not run_suites():
        print("BASELINE FAILS - fix the suites before running mutations")
        return 1

    caught = 0
    missed = []

    for path, description, old, new in MUTATIONS:
        original = path.read_text(encoding="utf-8")

        if old not in original:
            print(f"ANCHOR  {description}")
            print(f"        not found in {path.name}")
            missed.append(description + " (anchor)")
            continue

        if original.count(old) != 1:
            print(f"ANCHOR  {description}")
            print(f"        matches {original.count(old)} times in {path.name}")
            missed.append(description + " (ambiguous anchor)")
            continue

        path.write_text(original.replace(old, new), encoding="utf-8", newline="\n")

        try:
            if path in BUILD_AFTER and not build():
                print(f"CAUGHT  {description} (does not compile)")
                caught += 1
                continue

            passed = run_suites()
        finally:
            path.write_text(original, encoding="utf-8", newline="\n")
            if path in BUILD_AFTER:
                build()

        if passed:
            print(f"MISSED  {description}")
            missed.append(description)
        else:
            print(f"CAUGHT  {description}")
            caught += 1

    print()
    print(f"{caught}/{len(MUTATIONS)} caught")

    if missed:
        print("MISSED:")
        for description in missed:
            print(f"  - {description}")
        return 1

    if not run_suites():
        print("RESTORE FAILED - the tree did not come back clean")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
