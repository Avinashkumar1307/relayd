"""Negative controls for packages/billing/src/webhooks/refetch.ts."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages", "billing", "src", "webhooks", "refetch.ts")
TEST = "packages/billing/test/refetch.test.ts"

MUTATIONS = [
    ("the cooldown is ignored",
     "  if (!due) {",
     "  if (false) {"),

    ("everything is always due",
     "  const due = isDueForRefetch(object, {",
     "  const due = true || isDueForRefetch(object, {"),

    ("nothing is ever due",
     "  const due = isDueForRefetch(object, {",
     "  const due = false && isDueForRefetch(object, {"),

    ("an unsupported type is left dirty",
     "  if (!SUPPORTED.has(object.objectType)) {",
     "  if (false) {"),

    ("every type is unsupported",
     "  if (!SUPPORTED.has(object.objectType)) {",
     "  if (true) {"),

    ("an unsupported type is not cleared",
     "    await port.markFetched({\n      objectType: object.objectType,\n      providerObjectId: object.providerObjectId,\n      fetchedAt: input.now,\n    });\n\n    return { providerObjectId: object.providerObjectId, outcome: 'unsupported' };",
     "    return { providerObjectId: object.providerObjectId, outcome: 'unsupported' };"),

    ("a successful fetch does not clear the row",
     "    const applied = await applyOne(object, port, provider);\n\n    await port.markFetched({",
     "    const applied = await applyOne(object, port, provider);\n\n    if (false) await port.markFetched({"),

    ("a failure clears the row anyway",
     "    await port.markFetchFailed({",
     "    await port.markFetched({\n      objectType: object.objectType,\n      providerObjectId: object.providerObjectId,\n      fetchedAt: input.now,\n    });\n    await port.markFetchFailed({"),

    ("a failure is reported as applied",
     "    return {\n      providerObjectId: object.providerObjectId,\n      outcome: 'failed',",
     "    return {\n      providerObjectId: object.providerObjectId,\n      outcome: 'applied' as 'failed',"),

    ("the backoff does not grow",
     "      retryAfterMs: refetchBackoffMs(failures),\n      error: message,",
     "      retryAfterMs: 1,\n      error: message,"),

    ("a stale version is applied anyway",
     "    if (!isNewerThanStored({ fetchedVersion: subscription.stateVersion, storedVersion: stored })) {",
     "    if (false) {"),

    ("an equal version is applied",
     "    if (!isNewerThanStored({ fetchedVersion: subscription.stateVersion, storedVersion: stored })) {",
     "    if (subscription.stateVersion < stored) {"),

    ("a lost database race counts as applied",
     "    return applied ? 'applied' : 'discarded_stale';\n  }\n\n  const invoice = await provider.fetchInvoice(object.providerObjectId);",
     "    return 'applied';\n  }\n\n  const invoice = await provider.fetchInvoice(object.providerObjectId);"),

    ("a deleted object is retried forever",
     "    if (subscription === null) return 'gone';",
     "    if (subscription === null) throw new Error('missing');"),

    ("a deleted customer is treated as present",
     "    if (customer === null) return 'gone';",
     "    if (customer === null) return 'applied';"),

    ("the invoice version guard is dropped",
     "  if (!isNewerThanStored({ fetchedVersion: invoice.stateVersion, storedVersion: stored })) {",
     "  if (false) {"),

    ("a batch stops at the first failure",
     "    const one = await refetchObject(",
     "    if (result.failed > 0) break;\n    const one = await refetchObject("),

    ("a batch claims an unbounded page",
     "  const limit = Math.max(1, Math.floor(input.limit ?? 100));",
     "  const limit = Math.floor(input.limit ?? 100);"),

    ("a batch miscounts what it applied",
     "    if (one.outcome === 'applied') result.applied += 1;",
     "    if (one.outcome !== 'failed') result.applied += 1;"),

    ("a batch never counts a failure",
     "    if (one.outcome === 'failed') result.failed += 1;",
     "    if (false) result.failed += 1;"),

    ("the fetched object is discarded and the stored one written",
     "      subscription,\n      stateVersion: subscription.stateVersion,",
     "      subscription: { ...subscription, status: 'active' },\n      stateVersion: subscription.stateVersion,"),
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
