"""Negative controls for packages/billing/src/plans/change.ts."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages", "billing", "src", "plans", "change.ts")
TEST = "packages/billing/test/plan-change.test.ts"

MUTATIONS = [
    ("upgrade and downgrade swapped",
     "  if (isUpgrade(input.fromPlanCode, input.toPlanCode)) return 'upgrade';\n  if (isDowngrade(input.fromPlanCode, input.toPlanCode)) return 'downgrade';",
     "  if (isUpgrade(input.fromPlanCode, input.toPlanCode)) return 'downgrade';\n  if (isDowngrade(input.fromPlanCode, input.toPlanCode)) return 'upgrade';"),

    ("an interval change on the same plan reads as nothing",
     "  if (input.fromInterval === input.toInterval) return 'none';\n  return 'interval_only';",
     "  return 'none';"),

    ("the same plan reads as an interval change",
     "  if (input.fromInterval === input.toInterval) return 'none';",
     "  if (false) return 'none';"),

    ("an upgrade waits for period end",
     "      appliesAt: 'immediately',\n      prorate: true,\n      entitlementsAt: 'immediately',\n      requiresPrecheck: false,",
     "      appliesAt: 'period_end',\n      prorate: true,\n      entitlementsAt: 'immediately',\n      requiresPrecheck: false,"),

    ("an upgrade is not prorated",
     "      appliesAt: 'immediately',\n      prorate: true,\n      entitlementsAt: 'immediately',\n      requiresPrecheck: false,",
     "      appliesAt: 'immediately',\n      prorate: false,\n      entitlementsAt: 'immediately',\n      requiresPrecheck: false,"),

    ("a downgrade applies immediately",
     "      appliesAt: 'period_end',\n      prorate: false,\n      // Unchanged until the period rolls.",
     "      appliesAt: 'immediately',\n      prorate: false,\n      // Unchanged until the period rolls."),

    ("a downgrade lowers entitlements now",
     "      entitlementsAt: 'period_end',\n      requiresPrecheck: true,",
     "      entitlementsAt: 'immediately',\n      requiresPrecheck: true,"),

    ("a downgrade skips the pre-check",
     "      entitlementsAt: 'period_end',\n      requiresPrecheck: true,",
     "      entitlementsAt: 'period_end',\n      requiresPrecheck: false,"),

    ("a downgrade issues a credit",
     "      appliesAt: 'period_end',\n      prorate: false,\n      // Unchanged until the period rolls.",
     "      appliesAt: 'period_end',\n      prorate: true,\n      // Unchanged until the period rolls."),

    ("annual to monthly applies immediately",
     "    const lengthening = intervals.fromInterval === 'month' && intervals.toInterval === 'year';",
     "    const lengthening = true;"),

    ("monthly to annual waits",
     "    const lengthening = intervals.fromInterval === 'month' && intervals.toInterval === 'year';",
     "    const lengthening = false;"),

    ("the pre-check reports nothing blocked",
     "  return { blocked: conflicts.length > 0, conflicts };",
     "  return { blocked: false, conflicts };"),

    ("the pre-check reports only the first conflict",
     "  const conflicts = over.map((row) => ({",
     "  const conflicts = over.slice(0, 1).map((row) => ({"),

    ("the pre-check is not run",
     "  if (effect.requiresPrecheck) {",
     "  if (false) {"),

    ("a blocked downgrade proceeds anyway",
     "    if (precheck.blocked) {\n      return {",
     "    if (false) {\n      return {"),

    ("the provider is called before the pre-check",
     "  if (effect.requiresPrecheck) {\n    const precheck = precheckDowngrade({",
     "  await provider.updateSubscriptionPrice({\n    providerSubscriptionId: subscription.providerSubscriptionId,\n    priceId: 'x',\n    prorate: false,\n  });\n  if (effect.requiresPrecheck) {\n    const precheck = precheckDowngrade({"),

    ("a scheduled change is applied now instead",
     "  if (effect.appliesAt === 'immediately') {",
     "  if (true) {"),

    ("an immediate change is scheduled instead",
     "  if (effect.appliesAt === 'immediately') {",
     "  if (false) {"),

    ("a scheduled change lands on the wrong date",
     "      effectiveAt: subscription.currentPeriodEnd,\n    });",
     "      effectiveAt: new Date(0),\n    });"),

    ("an unknown plan accepted",
     "  if (planByCode(input.toPlanCode) === null) {",
     "  if (false) {"),

    ("a non-self-serve plan accepted",
     "  if (!input.isSelfServe(input.toPlanCode)) {",
     "  if (false) {"),

    ("a missing subscription ignored",
     "  if (subscription === null) {\n    return {\n      ok: false,\n      failure: 'no_subscription',\n      message: 'This workspace has no subscription to change',\n    };\n  }",
     "  if (subscription === null) {\n    return { ok: true };\n  }"),

    ("a missing price ignored",
     "  if (price === null) {\n    return { ok: false, failure: 'no_price', message: 'That plan has no price for this interval' };\n  }",
     "  if (false) {\n    return { ok: false, failure: 'no_price', message: 'That plan has no price for this interval' };\n  }"),

    ("a provider failure still writes locally",
     "  } catch {\n    return {\n      ok: false,\n      failure: 'provider_failed',\n      message: 'The payment provider could not apply the change',\n    };\n  }",
     "  } catch {\n    // swallowed\n  }"),

    ("a no-op change calls the provider",
     "  if (direction === 'none') {",
     "  if (false) {"),

    ("cancel defaults to immediate",
     "      atPeriodEnd: !input.immediately,",
     "      atPeriodEnd: false,"),

    ("cancel never ends immediately",
     "      atPeriodEnd: !input.immediately,",
     "      atPeriodEnd: true,"),

    ("cancel records an event even when the provider failed",
     "  } catch {\n    return {\n      ok: false,\n      failure: 'provider_failed',\n      message: 'The payment provider could not cancel the subscription',\n    };\n  }",
     "  } catch {\n    // swallowed\n  }"),

    ("cancel at period end reports no end date",
     "    ...(input.immediately ? {} : { endsAt: subscription.currentPeriodEnd }),",
     "    ...(input.immediately ? { endsAt: subscription.currentPeriodEnd } : {}),"),
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
