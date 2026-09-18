"""Negative controls for packages/billing/src/reconcile/reconcile.ts."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages", "billing", "src", "reconcile", "reconcile.ts")
TEST = "packages/billing/test/reconcile.test.ts"

MUTATIONS = [
    ("window shortened to a day",
     "export const RECONCILE_WINDOW_HOURS = 48;",
     "export const RECONCILE_WINDOW_HOURS = 24;"),

    ("a zero window accepted",
     "  const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : RECONCILE_WINDOW_HOURS;",
     "  const hours = Number.isFinite(windowHours) ? windowHours : RECONCILE_WINDOW_HOURS;"),

    ("the window is asked for forwards",
     "  return new Date(now.getTime() - hours * 3_600_000);",
     "  return new Date(now.getTime() + hours * 3_600_000);"),

    ("status drift not detected",
     "  if (local.status !== remote.status) {",
     "  if (false) {"),

    ("plan drift not detected",
     "  if (remotePlan !== null && remotePlan !== local.planCode) {",
     "  if (false) {"),

    ("an unknown price wipes the plan",
     "  if (remotePlan !== null && remotePlan !== local.planCode) {",
     "  if (remotePlan !== local.planCode) {"),

    ("period drift not detected",
     "    local.currentPeriodStart.getTime() !== remote.currentPeriodStart.getTime() ||\n    local.currentPeriodEnd.getTime() !== remote.currentPeriodEnd.getTime()",
     "    false"),

    ("period end ignored",
     "    local.currentPeriodStart.getTime() !== remote.currentPeriodStart.getTime() ||\n    local.currentPeriodEnd.getTime() !== remote.currentPeriodEnd.getTime()",
     "    local.currentPeriodStart.getTime() !== remote.currentPeriodStart.getTime()"),

    ("cancel flag drift not detected",
     "  if (local.cancelAtPeriodEnd !== remote.cancelAtPeriodEnd) {",
     "  if (false) {"),

    ("only the first difference reported",
     "  const out: Divergence[] = [];\n\n  const base = {",
     "  const out: Divergence[] & { push(d: Divergence): number } = Object.assign([] as Divergence[], {\n    push(this: Divergence[], d: Divergence) {\n      return this.length === 0 ? Array.prototype.push.call(this, d) : this.length;\n    },\n  });\n\n  const base = {"),

    ("a missing local row is auto-corrected",
     "  return (\n    kind === 'status' || kind === 'plan' || kind === 'period' || kind === 'cancel_at_period_end'\n  );",
     "  return true;"),

    ("nothing is auto-correctable",
     "  return (\n    kind === 'status' || kind === 'plan' || kind === 'period' || kind === 'cancel_at_period_end'\n  );",
     "  return false;"),

    ("a missing local row is invented",
     "    if (local === undefined) {",
     "    if (false && local === undefined) {"),

    ("a missing local row stops the run",
     "      result.missingLocally += 1;\n      port.emitDivergence(divergence);\n      continue;",
     "      result.missingLocally += 1;\n      port.emitDivergence(divergence);\n      break;"),

    ("no metric is emitted for a correction",
     "      result.divergences.push(recorded);\n      if (corrected) result.corrected += 1;\n      port.emitDivergence(recorded);",
     "      result.divergences.push(recorded);\n      if (corrected) result.corrected += 1;"),

    ("a refused write is counted as corrected",
     "      const corrected = applied && isAutoCorrectable(difference.kind);",
     "      const corrected = isAutoCorrectable(difference.kind);"),

    ("a refused write still rebuilds entitlements",
     "      if (\n        applied &&\n        !rebuilt &&\n        (difference.kind === 'plan' || difference.kind === 'status')\n      ) {",
     "      if (\n        !rebuilt &&\n        (difference.kind === 'plan' || difference.kind === 'status')\n      ) {"),

    ("entitlements rebuilt for any drift",
     "      if (\n        applied &&\n        !rebuilt &&\n        (difference.kind === 'plan' || difference.kind === 'status')\n      ) {",
     "      if (applied && !rebuilt) {"),

    ("entitlements never rebuilt",
     "    if (rebuilt) await port.rebuildEntitlements(local.workspaceId);",
     "    if (false) await port.rebuildEntitlements(local.workspaceId);"),

    ("the run is not recorded before work starts",
     "  const runId = await port.startRun(input.now);",
     "  const runId = 'unrecorded';\n  void port.startRun;"),

    ("a failed list leaves no trace",
     "    await port.finishRun({\n      runId,\n      finishedAt: input.now,\n      objectsChecked: 0,\n      divergencesFound: 0,\n      divergencesCorrected: 0,\n      detail: [],\n      error: error instanceof Error ? error.message : 'unknown',\n    });\n    throw error;",
     "    throw error;"),

    ("the run is never finished",
     "  await port.finishRun({\n    runId,\n    finishedAt: input.now,\n    objectsChecked: result.objectsChecked,",
     "  void port.finishRun;\n  const unused = ({\n    runId,\n    finishedAt: input.now,\n    objectsChecked: result.objectsChecked,"),

    ("the write is applied per field",
     "    const applied = await port.applyRemote({",
     "    for (const _ of differences) await port.applyRemote({\n      subscriptionId: local.id,\n      workspaceId: local.workspaceId,\n      planCode: null,\n      status: row.status,\n      currentPeriodStart: row.currentPeriodStart,\n      currentPeriodEnd: row.currentPeriodEnd,\n      cancelAtPeriodEnd: row.cancelAtPeriodEnd,\n      stateVersion: row.stateVersion,\n    });\n    const applied = await port.applyRemote({"),

    ("an agreeing subscription is written anyway",
     "    if (differences.length === 0) continue;",
     "    if (false) continue;"),

    ("the local state version is written instead of the remote one",
     "      stateVersion: row.stateVersion,\n    });\n\n    let rebuilt = false;",
     "      stateVersion: local.providerStateVersion,\n    });\n\n    let rebuilt = false;"),

    ("past due counted as a revocation",
     "  return grantsEntitlements(input.from) && !grantsEntitlements(input.to);",
     "  return input.from !== input.to;"),

    ("a restoration counted as a revocation",
     "  return grantsEntitlements(input.from) && !grantsEntitlements(input.to);",
     "  return !grantsEntitlements(input.to);"),
]


def run():
    return subprocess.run(
        ["node", os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
         "run", TEST, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True, errors="replace", timeout=300,
    )


def main():
    original = open(SRC, encoding="utf-8").read()

    baseline = run()
    if baseline.returncode != 0:
        print("BASELINE FAILS")
        print(baseline.stdout[-3000:])
        return 1

    print("baseline green\n")
    missed = []

    for name, old, new in MUTATIONS:
        if original.count(old) != 1:
            print("SKIP    %-52s (anchor matched %d)" % (name, original.count(old)))
            missed.append(name + " [anchor]")
            continue

        open(SRC, "w", encoding="utf-8", newline="\n").write(original.replace(old, new, 1))
        try:
            verdict = "CAUGHT" if run().returncode != 0 else "MISSED"
        except subprocess.TimeoutExpired:
            verdict = "HANG"
        finally:
            open(SRC, "w", encoding="utf-8", newline="\n").write(original)

        print("%-7s %s" % (verdict, name))
        if verdict != "CAUGHT":
            missed.append(name)

    print("\n%d/%d caught" % (len(MUTATIONS) - len(missed), len(MUTATIONS)))
    if missed:
        print("MISSED:")
        for m in missed:
            print("  - " + m)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
