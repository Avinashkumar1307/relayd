"""Negative controls for the new-workspace ramp (BUILD-PLAN Phase 11).

Covers:
  packages/campaigns/test/ramp.test.ts
  packages/campaigns/test/dispatch.test.ts
  packages/campaigns/test/launch.test.ts
  packages/db/test/ramp-repository.test.ts
  apps/api/test/campaigns.test.ts

docs/06 opens the anti-abuse section with the reason these matter: "A tool
that sends bulk email will be signed up for by spammers within weeks.
Undetected, your customers' providers suspend them, your processor sees
disputes, and your link domain's reputation collapses."

Every mutation below is a way the cap stops capping while everything still
looks like it works.

Run: python3 .nc/nc_ramp.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = [
    "packages/campaigns/test/ramp.test.ts",
    "packages/campaigns/test/dispatch.test.ts",
    "packages/campaigns/test/launch.test.ts",
    "packages/db/test/ramp-repository.test.ts",
    "apps/api/test/campaigns.test.ts",
]

RAMP = ROOT / "packages/campaigns/src/abuse/ramp.ts"
DISPATCH = ROOT / "packages/campaigns/src/engine/dispatch.ts"
LAUNCH = ROOT / "packages/campaigns/src/engine/launch.ts"
REPO = ROOT / "packages/db/src/repositories/ramp.ts"
SERVICE = ROOT / "apps/api/src/services/campaigns.ts"

BUILD_AFTER = {RAMP, DISPATCH, LAUNCH, REPO}

# (file, description, old, new)
MUTATIONS = [
    # --- the policy -----------------------------------------------------
    (RAMP, "the cap is raised out of usefulness",
     "export const RAMP_DAILY_CAP = 500;", "export const RAMP_DAILY_CAP = 500_000;"),
    (RAMP, "the ramp window is shortened to nothing",
     "export const RAMP_DAYS = 7;", "export const RAMP_DAYS = 0;"),
    (RAMP, "the ramp lasts one day longer than docs/06 says",
     "export const RAMP_DAYS = 7;", "export const RAMP_DAYS = 8;"),
    (RAMP, "a future created_at reads as an ancient workspace",
     "  if (ms <= 0) return 0;", "  if (false) return 0;"),
    (RAMP, "a workspace with no trust row is treated as trusted",
     "  if (subject.trust?.rampLiftedAt != null) return false;\n",
     "  if (subject.trust == null) return false;\n"),
    (RAMP, "an old lift beats a fresh operator extension",
     "  const until = subject.trust?.rampUntil ?? null;\n"
     "  if (until !== null && until.getTime() > now.getTime()) return true;\n"
     "\n"
     "  if (subject.trust?.rampLiftedAt != null) return false;",
     "  if (subject.trust?.rampLiftedAt != null) return false;\n"
     "\n"
     "  const until = subject.trust?.rampUntil ?? null;\n"
     "  if (until !== null && until.getTime() > now.getTime()) return true;"),
    (RAMP, "the day boundary is off by one, letting a 501st send through",
     "  if (sentToday >= cap) {", "  if (sentToday > cap) {"),
    (RAMP, "a batch is refused whole instead of trimmed",
     "  return Math.min(requested, gate.remaining);", "  return 0;"),
    (RAMP, "an uncapped workspace is trimmed to nothing",
     "  if (gate.remaining === null) return requested;",
     "  if (gate.remaining === null) return 0;"),
    (RAMP, "pool routing checks the wrong creation date",
     "  return isInRamp(subject, now);\n}\n\nexport type SendGate",
     "  return isInRamp({ ...subject, createdAt: new Date(0) }, now);\n}\n\nexport type SendGate"),
    (RAMP, "the quota day follows the machine timezone",
     "  return now.toISOString().slice(0, 10);",
     "  return now.toLocaleDateString('en-CA');"),
    (RAMP, "the automatic lift ignores complaints",
     "  if (metrics.complaints / metrics.sent > AUTO_LIFT_MAX_COMPLAINT_RATE) {",
     "  if (false) {"),
    (RAMP, "the automatic lift ignores bounces",
     "  if (metrics.bounces / metrics.sent > AUTO_LIFT_MAX_BOUNCE_RATE) {",
     "  if (false) {"),
    (RAMP, "the lift fires on a handful of sends",
     "  if (metrics.sent < AUTO_LIFT_MIN_SENDS) return { lift: false, reason: 'too_few_sends' };",
     ""),
    (RAMP, "clean metrics override an operator extension",
     "  if (until !== null && until.getTime() > now.getTime()) return { lift: false, reason: 'still_young' };",
     "  if (until !== null && until.getTime() < now.getTime()) return { lift: false, reason: 'still_young' };"),
    (RAMP, "an already-lifted workspace is lifted again",
     "  if (subject.trust?.rampLiftedAt != null) return { lift: false, reason: 'already_lifted' };",
     ""),
    # --- enforcement in dispatch ----------------------------------------
    (DISPATCH, "the cap is read once per dispatch rather than per page",
     "    let allowed = Math.min(page, window - inFlight);\n"
     "    const ramp = await port.readRampState(campaign.workspaceId);",
     "    let allowed = Math.min(page, window - inFlight);\n"
     "    const ramp = pages === 0 ? await port.readRampState(campaign.workspaceId) : null;"),
    (DISPATCH, "the ramp allowance overrides the window instead of composing with it",
     "        allowed,\n        port.now(),",
     "        page,\n        port.now(),"),
    (DISPATCH, "a capped campaign is reported as completed",
     "        return {\n          stopped: 'ramp_capped',",
     "        await port.maybeComplete(campaignId);\n        return {\n          stopped: 'completed',"),
    (DISPATCH, "the cap stops nothing",
     "      if (allowed === 0) {", "      if (allowed === -1) {"),
    (DISPATCH, "stopping on the cap records no event",
     "        await port.recordEvent({\n"
     "          campaignId,\n"
     "          eventType: 'dispatch.ramp_capped',\n"
     "          detail: { sentToday: ramp.sentToday },\n"
     "        });\n", ""),
    # --- enforcement at launch ------------------------------------------
    (LAUNCH, "an unverified account may launch",
     "  if (!(await port.ownerEmailIsVerified(campaign.workspaceId))) {", "  if (false) {"),
    (LAUNCH, "the account check happens after the snapshot",
     "  if (!(await port.ownerEmailIsVerified(campaign.workspaceId))) {\n"
     "    return fail(\n"
     "      'unverified_account',\n"
     "      'Verify the workspace owner’s email address before sending',\n"
     "    );\n"
     "  }\n", ""),
    (LAUNCH, "a ramped workspace may route through a pool",
     "  if (campaign.sendingPoolId !== null && (await port.workspaceIsInRamp(campaign.workspaceId))) {",
     "  if (false) {"),
    (LAUNCH, "the pool refusal applies to every workspace, not only new ones",
     "  if (campaign.sendingPoolId !== null && (await port.workspaceIsInRamp(campaign.workspaceId))) {",
     "  if (campaign.sendingPoolId !== null) {"),
    # --- the counter ----------------------------------------------------
    (REPO, "the counter overwrites instead of adding",
     "          sent: sql`${workspaceSendQuota.sent} + ${count}`,", "          sent: count,"),
    (REPO, "an empty page writes a quota row",
     "    if (count <= 0) {", "    if (false) {"),
    (REPO, "the lift is no longer first-writer-wins",
     "        where: sql`${workspaceTrust.rampLiftedAt} is null`,", ""),
    (REPO, "extending the ramp leaves a stale lift in place",
     "          rampLiftedAt: null,\n          rampLiftedBy: null,\n", ""),
    # --- the API status -------------------------------------------------
    (SERVICE, "an anti-abuse refusal is reported as a malformed request",
     "  unverified_account: 403,", "  unverified_account: 422,"),
    (SERVICE, "the pool refusal is reported as a malformed request",
     "  pool_routing_unavailable: 403,", "  pool_routing_unavailable: 422,"),
]


def build() -> bool:
    result = subprocess.run(
        ["pnpm", "turbo", "run", "build", "--filter=@relayd/campaigns", "--filter=@relayd/db"],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", shell=True, timeout=900,
    )
    return result.returncode == 0


def run_suites() -> bool:
    result = subprocess.run(
        ["node", "node_modules/vitest/vitest.mjs", "run", *SUITES, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=900,
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
