"""Negative controls for packages/db/src/repositories/metering.ts."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages", "db", "src", "repositories", "metering.ts")
TEST = "packages/db/test/metering-repository.test.ts"

MUTATIONS = [
    ("counter moves even when the ledger refused the row",
     "    if ((inserted.rows.length ?? 0) === 0) return false;",
     "    if (false) return false;"),

    ("ledger insert loses RETURNING",
     "      ON CONFLICT DO NOTHING\n      RETURNING id",
     "      ON CONFLICT DO NOTHING"),

    ("ledger insert overwrites instead of doing nothing",
     "      ON CONFLICT DO NOTHING\n      RETURNING id",
     "      ON CONFLICT (id, occurred_at) DO UPDATE SET quantity = EXCLUDED.quantity\n      RETURNING id"),

    ("inline watermark assigned rather than advanced",
     "          last_usage_record_id =\n            GREATEST(usage_aggregates.last_usage_record_id, EXCLUDED.last_usage_record_id),",
     "          last_usage_record_id = EXCLUDED.last_usage_record_id,"),

    ("counter replaced rather than incremented",
     "      SET used = usage_aggregates.used + EXCLUDED.used,",
     "      SET used = EXCLUDED.used,"),

    ("quantity floor removed",
     "    const quantity = Math.max(1, Math.trunc(input.quantity ?? 1));",
     "    const quantity = Math.trunc(input.quantity ?? 1);"),

    ("ledger read unordered",
     "      ORDER BY id\n      LIMIT",
     "      LIMIT"),

    ("ledger read descending",
     "      ORDER BY id\n      LIMIT",
     "      ORDER BY id DESC\n      LIMIT"),

    ("watermark read inclusive",
     "        AND (${input.afterId}::uuid IS NULL OR id > ${input.afterId}::uuid)",
     "        AND (${input.afterId}::uuid IS NULL OR id >= ${input.afterId}::uuid)"),

    ("null watermark filters out every row",
     "        AND (${input.afterId}::uuid IS NULL OR id > ${input.afterId}::uuid)",
     "        AND id > ${input.afterId}::uuid"),

    ("lag window dropped",
     "        AND occurred_at < ${input.before}\n",
     ""),

    ("page limit floor removed",
     "    const limit = Math.max(1, Math.trunc(input.limit));",
     "    const limit = Math.trunc(input.limit);"),

    ("compare-and-set becomes equality",
     "        AND last_usage_record_id IS NOT DISTINCT FROM ${input.expectedWatermark}::uuid",
     "        AND last_usage_record_id = ${input.expectedWatermark}::uuid"),

    ("compare-and-set dropped entirely",
     "        AND last_usage_record_id IS NOT DISTINCT FROM ${input.expectedWatermark}::uuid\n",
     ""),

    ("catch-up can subtract",
     "      SET used = used + ${Math.max(0, Math.trunc(input.addUsed))},",
     "      SET used = used + ${Math.trunc(input.addUsed)},"),

    ("a lost race reported as applied",
     "    return (result.rows.length ?? 0) > 0;",
     "    return true;"),

    ("opening a period resets the counter",
     "      SET period_end = EXCLUDED.period_end,",
     "      SET used = 0,\n          period_end = EXCLUDED.period_end,"),

    ("opening a period rewinds the watermark",
     "      SET period_end = EXCLUDED.period_end,",
     "      SET last_usage_record_id = NULL,\n          period_end = EXCLUDED.period_end,"),

    ("aggregate read unscoped",
     "      FROM usage_aggregates\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n        AND feature_key = ${key.featureKey}",
     "      FROM usage_aggregates\n      WHERE feature_key = ${key.featureKey}"),

    ("ledger read unscoped",
     "      FROM usage_records\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n        AND feature_key = ${input.featureKey}",
     "      FROM usage_records\n      WHERE feature_key = ${input.featureKey}"),

    ("ledger count unscoped",
     "      FROM usage_records\n      WHERE workspace_id = ${scope.workspaceId}::uuid\n        AND feature_key = ${key.featureKey}",
     "      FROM usage_records\n      WHERE feature_key = ${key.featureKey}"),

    ("catch-up write unscoped",
     "      WHERE workspace_id = ${scope.workspaceId}::uuid\n        AND feature_key = ${input.featureKey}\n        AND period_start = ${input.periodStart}\n        -- The compare-and-set",
     "      WHERE feature_key = ${input.featureKey}\n        AND period_start = ${input.periodStart}\n        -- The compare-and-set"),

    ("bigint used read as a string",
     "      used: Number(row['used']),",
     "      used: row['used'] as number,"),

    ("unlimited collapsed into zero",
     "      included: row['included'] === null ? null : Number(row['included']),",
     "      included: Number(row['included']),"),

    ("ledger count read as a string",
     "    return row === undefined ? 0 : Number(row['n']);",
     "    return row === undefined ? 0 : (row['n'] as number);"),

    ("missing counter row read as an empty object",
     "    if (row === undefined) return null;",
     "    if (false) return null;"),
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
