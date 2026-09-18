"""Negative controls for packages/billing/src/metering/meter.ts.

Each entry breaks one guard. The suite must fail for every one of them; a
mutation the suite survives is a guard nothing is testing.
"""

import subprocess, sys, os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages", "billing", "src", "metering", "meter.ts")
TEST = "packages/billing/test/metering.test.ts"

MUTATIONS = [
    ("watermark retreats",
     "if (highest === null || compareUsageIds(row.id, highest) > 0) {",
     "if (highest === null || compareUsageIds(row.id, highest) < 0) {"),

    ("watermark takes the last row, not the highest",
     "if (highest === null || compareUsageIds(row.id, highest) > 0) {",
     "if (true) {"),

    ("case folding dropped from the id compare",
     "  const left = a.toLowerCase();\n  const right = b.toLowerCase();",
     "  const left = a;\n  const right = b;"),

    ("negative quantities counted",
     "    if (!Number.isFinite(row.quantity) || row.quantity <= 0) continue;",
     "    if (false) continue;"),

    ("non-finite quantity counted",
     "    if (!Number.isFinite(row.quantity) || row.quantity <= 0) continue;",
     "    if (row.quantity <= 0) continue;"),

    ("watermark not advanced past an uncounted row",
     "  return { added, counted: rows.length, watermark: advanceWatermark(current, rows) };",
     "  return { added, counted: rows.length, watermark: current };"),

    ("no lag window",
     "  return new Date(now.getTime() - lag);",
     "  return new Date(now.getTime());"),

    ("a zero lag accepted",
     "  const lag = Number.isFinite(lagMs) && lagMs > 0 ? lagMs : AGGREGATION_LAG_MS;",
     "  const lag = Number.isFinite(lagMs) && lagMs >= 0 ? lagMs : AGGREGATION_LAG_MS;",),

    ("lag shortened",
     "export const AGGREGATION_LAG_MS = 60_000;",
     "export const AGGREGATION_LAG_MS = 30_000;"),

    ("read starts from the beginning every run",
     "    afterId: aggregate.lastUsageRecordId,\n    before,",
     "    afterId: null,\n    before,"),

    ("watermark never advanced by the catch-up",
     "    watermark: fold.watermark,\n    expectedWatermark: aggregate.lastUsageRecordId,",
     "    watermark: aggregate.lastUsageRecordId,\n    expectedWatermark: aggregate.lastUsageRecordId,"),

    ("compare-and-set dropped",
     "    expectedWatermark: aggregate.lastUsageRecordId,\n  });",
     "    expectedWatermark: null,\n  });"),

    ("a refused write reported as applied",
     "  if (!applied) {",
     "  if (false) {"),

    ("aggregation invents a counter row",
     "    return { counted: 0, added: 0, watermark: null, more: false, contended: false };",
     "    // mutated\n  }\n  if (false) {\n    return { counted: 0, added: 0, watermark: null, more: false, contended: false };"),

    ("page size of zero allowed",
     "  return Math.min(AGGREGATION_PAGE, Math.max(1, Math.floor(requested)));",
     "  return Math.min(AGGREGATION_PAGE, Math.max(0, Math.floor(requested)));"),

    ("page size cap removed",
     "  return Math.min(AGGREGATION_PAGE, Math.max(1, Math.floor(requested)));",
     "  return Math.max(1, Math.floor(requested));"),

    ("more-to-do never reported",
     "    more: rows.length >= limit,",
     "    more: false,"),

    ("contention does not stop the drain",
     "    if (!result.more) break;\n    if (result.contended) break;",
     "    if (!result.more) break;"),

    ("maxPages ignored",
     "  const maxPages = Math.max(1, Math.floor(input.maxPages ?? 50));",
     "  const maxPages = 50;"),

    ("overage on an unlimited feature",
     "  if (included === null) return 0;\n  if (!Number.isFinite(used) || !Number.isFinite(included)) return 0;",
     "  if (included === null) return Math.trunc(used);\n  if (!Number.isFinite(used) || !Number.isFinite(included)) return 0;"),

    ("overage goes negative inside the allowance",
     "  return Math.max(0, Math.trunc(used) - Math.trunc(included));",
     "  return Math.trunc(used) - Math.trunc(included);"),

    ("hard cap off by one",
     "  return Math.trunc(used) > cap;",
     "  return Math.trunc(used) >= cap;"),

    ("hard cap applied to an unlimited feature",
     "  if (included === null) return null;\n  if (!Number.isFinite(included)) return null;\n  return Math.max(0, Math.trunc(included))",
     "  if (included === null) return 0;\n  if (!Number.isFinite(included)) return null;\n  return Math.max(0, Math.trunc(included))"),

    ("reconcile direction inverted",
     "  return used < ledger ? 'counter_behind' : 'counter_ahead';",
     "  return used < ledger ? 'counter_ahead' : 'counter_behind';"),

    ("reconcile calls any drift exact",
     "  if (used === ledger) return 'exact';",
     "  if (true) return 'exact';"),

    ("ledger key carries the attempt",
     "  return `send:${recipientId}`;",
     "  return `send:${recipientId}:${Math.random()}`;"),
]


def run():
    return subprocess.run(
        [
            "node",
            os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
            "run",
            TEST,
            "--reporter=basic",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        timeout=300,
    )


def main():
    original = open(SRC, encoding="utf-8").read()

    baseline = run()
    if baseline.returncode != 0:
        print("BASELINE FAILS -- fix before running negative controls")
        print(baseline.stdout[-3000:])
        return 1

    print("baseline green\n")
    missed = []

    for name, old, new in MUTATIONS:
        if original.count(old) != 1:
            print("SKIP  %-52s (anchor matched %d times)" % (name, original.count(old)))
            missed.append(name + " [anchor]")
            continue

        open(SRC, "w", encoding="utf-8").write(original.replace(old, new, 1))
        try:
            result = run()
            verdict = "CAUGHT" if result.returncode != 0 else "MISSED"
        except subprocess.TimeoutExpired:
            verdict = "HANG"
        finally:
            open(SRC, "w", encoding="utf-8").write(original)

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
