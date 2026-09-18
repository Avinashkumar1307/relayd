"""Negative controls for the entitlement gate, the rebuild, and their SQL."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

GATE = os.path.join(ROOT, "packages", "billing", "src", "entitlements", "gate.ts")
REBUILD = os.path.join(ROOT, "packages", "billing", "src", "entitlements", "rebuild.ts")
REPO = os.path.join(ROOT, "packages", "db", "src", "repositories", "entitlements.ts")
LAUNCH = os.path.join(ROOT, "packages", "campaigns", "src", "engine", "launch.ts")

TESTS = [
    "packages/billing/test/gate.test.ts",
    "packages/billing/test/rebuild.test.ts",
    "packages/db/test/entitlements-repository.test.ts",
    "packages/campaigns/test/launch.test.ts",
]

MUTATIONS = [
    # -------------------------------------------------------------- the gate
    (GATE, "no subscription waved through",
     "  if (!state.hasSubscription) {",
     "  if (false) {"),

    (GATE, "an absent feature allowed",
     "  if (grant === undefined) {\n    return deny('feature_not_in_plan', 'Your plan does not include this feature', { featureKey });\n  }",
     "  if (grant === undefined) {\n    return { allowed: true };\n  }"),

    (GATE, "a switched-off flag allowed",
     "  if (grant.flagValue === false) {",
     "  if (false) {"),

    (GATE, "limit off by one, generous",
     "  if (requested <= remaining) return { allowed: true };",
     "  if (requested <= remaining + 1) return { allowed: true };"),

    (GATE, "limit off by one, mean",
     "  if (requested <= remaining) return { allowed: true };",
     "  if (requested < remaining) return { allowed: true };"),

    (GATE, "unlimited treated as zero",
     "  if (grant === undefined || grant.limitValue === null) return { allowed: true };",
     "  if (grant === undefined) return { allowed: true };"),

    (GATE, "remaining goes negative",
     "  const remaining = Math.max(0, limit - used);",
     "  const remaining = limit - used;"),

    (GATE, "a request defaults to zero",
     "  const requested = Math.max(0, Math.trunc(input.requested ?? 1));",
     "  const requested = Math.max(0, Math.trunc(input.requested ?? 0));"),

    (GATE, "suspension checked after the quota",
     "  const blocked = blockedByState(featureKey, state);\n  if (blocked !== null) return blocked;",
     "  const blocked = null as Decision | null;\n  if (blocked !== null) return blocked;"),

    (GATE, "workspace suspension ignored",
     "  if (state.workspaceSuspended) {",
     "  if (false) {"),

    (GATE, "unpaid subscription ignored",
     "  if (state.subscriptionSuspended) {",
     "  if (false) {"),

    (GATE, "past due does not block sending",
     "  if (state.pastDue && BLOCKED_WHILE_PAST_DUE.has(featureKey)) {",
     "  if (false) {"),

    (GATE, "past due blocks everything",
     "  if (state.pastDue && BLOCKED_WHILE_PAST_DUE.has(featureKey)) {",
     "  if (state.pastDue) {"),

    (GATE, "a usage check skips the feature check",
     "  const usable = canUseFeature(featureKey, grants, state);\n  if (!usable.allowed) return usable;",
     "  const usable = { allowed: true } as Decision;\n  if (!usable.allowed) return usable;"),

    (GATE, "every denial is 402",
     "  return code === 'workspace_suspended' ? 403 : 402;",
     "  return 402;"),

    (GATE, "every denial is 403",
     "  return code === 'workspace_suspended' ? 403 : 402;",
     "  return 403;"),

    # ------------------------------------------------------------ the rebuild
    (REBUILD, "unchanged workspaces rewritten anyway",
     "  if (!entitlementsDiffer(current, projected)) {",
     "  if (false) {"),

    (REBUILD, "changed workspaces not written",
     "  await port.writeEntitlements(workspaceId, projected);",
     "  if (projected.length < 0) await port.writeEntitlements(workspaceId, projected);"),

    (REBUILD, "cache invalidated before the write",
     "  await port.writeEntitlements(workspaceId, projected);\n\n  // After the write.",
     "  await port.invalidate(workspaceId);\n  await port.writeEntitlements(workspaceId, projected);\n\n  // After the write."),

    (REBUILD, "a revoked workspace is not written",
     "  await port.writeEntitlements(workspaceId, projected);",
     "  if (projected.length > 0) await port.writeEntitlements(workspaceId, projected);"),

    (REBUILD, "a batch stops at the first failure",
     "    } catch (error) {\n      result.failed.push({",
     "    } catch (error) {\n      throw error;\n      result.failed.push({"),

    (REBUILD, "a failure counted as checked",
     "      const one = await rebuildEntitlements(workspaceId, port);\n      result.checked += 1;",
     "      result.checked += 1;\n      const one = await rebuildEntitlements(workspaceId, port);"),

    # ----------------------------------------------------------------- the SQL
    (REPO, "R28 share lock dropped",
     "      ORDER BY feature_key\n      FOR SHARE",
     "      ORDER BY feature_key"),

    (REPO, "R28 lock made exclusive",
     "      FOR SHARE\n",
     "      FOR UPDATE\n"),

    (REPO, "the unlocked read takes the lock too",
     "             source_subscription_id, source_plan_code\n      FROM entitlements\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n      ORDER BY feature_key\n    `);\n\n    return (result.rows as Record<string, unknown>[]).map(toRecord);\n  }\n\n  /**\n   * Replaces",
     "             source_subscription_id, source_plan_code\n      FROM entitlements\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n      ORDER BY feature_key\n      FOR SHARE\n    `);\n\n    return (result.rows as Record<string, unknown>[]).map(toRecord);\n  }\n\n  /**\n   * Replaces"),

    (REPO, "rebuild delete unscoped",
     "      DELETE FROM entitlements WHERE workspace_id = ${scope.workspaceId}::uuid",
     "      DELETE FROM entitlements WHERE true"),

    (REPO, "rebuild skips the delete when there is nothing to insert",
     "    await this.db.execute(sql`\n      DELETE FROM entitlements WHERE workspace_id = ${scope.workspaceId}::uuid\n    `);\n\n    if (rows.length === 0) {",
     "    if (rows.length === 0) {\n      return;\n    }\n    await this.db.execute(sql`\n      DELETE FROM entitlements WHERE workspace_id = ${scope.workspaceId}::uuid\n    `);\n\n    if (rows.length === 0) {"),

    (REPO, "read order not fixed",
     "      FROM entitlements\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n      ORDER BY feature_key\n      FOR SHARE",
     "      FROM entitlements\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n      FOR SHARE"),

    (REPO, "unlimited collapsed to zero on read",
     "    limitValue: row['limit_value'] === null ? null : Number(row['limit_value']),",
     "    limitValue: Number(row['limit_value']),"),

    (REPO, "an absent flag collapsed to false",
     "    flagValue: row['flag_value'] === null ? null : Boolean(row['flag_value']),",
     "    flagValue: Boolean(row['flag_value']),"),

    (REPO, "unpaid counted as a subscription",
     "      hasSubscription:\n        subscriptionStatus !== null && subscriptionStatus !== 'unpaid',",
     "      hasSubscription: subscriptionStatus !== null,"),

    (REPO, "unpaid not treated as suspended",
     "      subscriptionSuspended: subscriptionStatus === 'unpaid',",
     "      subscriptionSuspended: false,"),

    (REPO, "past due not reported",
     "      pastDue: subscriptionStatus === 'past_due',",
     "      pastDue: false,"),

    (REPO, "a missing workspace opens everything",
     "        workspaceSuspended: true,\n        subscriptionId: null,",
     "        workspaceSuspended: false,\n        subscriptionId: null,"),

    (REPO, "suspended workspace status ignored",
     "      workspaceSuspended: String(row['workspace_status'] ?? '') === 'suspended',",
     "      workspaceSuspended: false,"),

    (REPO, "the state join takes any subscription",
     "       AND s.status IN ('trialing', 'active', 'past_due', 'unpaid')",
     "       AND true"),

    (REPO, "the rebuild source ignores unpaid",
     "        AND status IN ('trialing', 'active', 'past_due', 'unpaid')",
     "        AND status IN ('trialing', 'active', 'past_due')"),

    # --------------------------------------------------------------- R28 stub
    (LAUNCH, "a null entitlement means unlimited again",
     "  if (entitlement === null) {",
     "  if (false as boolean) {"),

    (LAUNCH, "no entitlement still snapshots",
     "    return fail(\n      'no_entitlement',\n      'This workspace has no active subscription. Choose a plan to start sending.',\n    );",
     "    void fail('no_entitlement', 'x');"),
]


def run():
    return subprocess.run(
        ["node", os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
         "run", *TESTS, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True, errors="replace", timeout=400,
    )


def main():
    originals = {path: open(path, encoding="utf-8").read() for path in {m[0] for m in MUTATIONS}}

    baseline = run()
    if baseline.returncode != 0:
        print("BASELINE FAILS")
        print(baseline.stdout[-4000:])
        return 1

    print("baseline green\n")
    missed = []

    for path, name, old, new in MUTATIONS:
        source = originals[path]
        if source.count(old) != 1:
            print("SKIP    %-52s (anchor matched %d)" % (name, source.count(old)))
            missed.append(name + " [anchor]")
            continue

        open(path, "w", encoding="utf-8", newline="\n").write(source.replace(old, new, 1))
        try:
            verdict = "CAUGHT" if run().returncode != 0 else "MISSED"
        except subprocess.TimeoutExpired:
            verdict = "HANG"
        finally:
            open(path, "w", encoding="utf-8", newline="\n").write(source)

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
