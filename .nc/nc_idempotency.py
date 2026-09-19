"""Negative controls for the idempotency middleware and its repository."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MW = os.path.join(ROOT, "apps", "api", "src", "middleware", "idempotency.ts")
TEST = "apps/api/test/idempotency.test.ts"

MUTATIONS = [
    ("the request body is not compared",
     "  if (!existing.requestHash.equals(input.requestHash)) return { kind: 'reuse' };",
     "  if (false) return { kind: 'reuse' };"),

    ("a mismatched body replays instead of erroring",
     "  if (!existing.requestHash.equals(input.requestHash)) return { kind: 'reuse' };\n\n  if (existing.status === 'completed') {",
     "  if (existing.status === 'completed') {"),

    ("a completed row is re-run instead of replayed",
     "  if (existing.status === 'completed') {",
     "  if (false) {"),

    ("the replay loses the original status",
     "      responseCode: existing.responseCode ?? 200,",
     "      responseCode: 200,"),

    ("a vanished row is treated as in progress",
     "  if (existing === null) return { kind: 'stale' };",
     "  if (existing === null) return { kind: 'in_progress' };"),

    ("a claim with no lock time is held forever",
     "  if (existing.lockedAt === null) return { kind: 'stale' };",
     "  if (existing.lockedAt === null) return { kind: 'in_progress' };"),

    ("a fresh claim is stolen",
     "  return heldFor >= input.lockMs ? { kind: 'stale' } : { kind: 'in_progress' };",
     "  return { kind: 'stale' };"),

    ("a dead claim is never released",
     "  return heldFor >= input.lockMs ? { kind: 'stale' } : { kind: 'in_progress' };",
     "  return { kind: 'in_progress' };"),

    ("the lock boundary is off by one",
     "  return heldFor >= input.lockMs ? { kind: 'stale' } : { kind: 'in_progress' };",
     "  return heldFor > input.lockMs ? { kind: 'stale' } : { kind: 'in_progress' };"),

    ("key order changes the hash",
     "    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));",
     "    ;"),

    ("array order stops mattering",
     "    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;",
     "    return `[${value.map((item) => canonicalJson(item)).sort().join(',')}]`;"),

    ("an undefined member changes the hash",
     "    .filter(([, member]) => member !== undefined)",
     "    .filter(() => true)"),

    ("null and absent hash the same",
     "    .filter(([, member]) => member !== undefined)",
     "    .filter(([, member]) => member !== undefined && member !== null)"),

    ("the header is optional everywhere",
     "      if (required) {",
     "      if (false) {"),

    ("the header is required even where a route says otherwise",
     "      if (required) {",
     "      if (true) {"),

    ("the key length is unbounded",
     "    if (key.length < MIN_KEY_LENGTH || key.length > MAX_KEY_LENGTH) {",
     "    if (false) {"),

    ("the endpoint is dropped from the key",
     "    const { claimed, existing } = await options.store.claim(scope, {\n      key,\n      endpoint,",
     "    const { claimed, existing } = await options.store.claim(scope, {\n      key,\n      endpoint: 'any',"),

    ("a lost claim runs the handler anyway",
     "      if (decision.kind === 'replay') {\n        res.set('Idempotent-Replay', 'true');\n        res.status(decision.responseCode).json(decision.responseBody);\n        return;\n      }",
     "      if (decision.kind === 'replay') {\n        res.set('Idempotent-Replay', 'true');\n      }"),

    ("a reuse is answered with a replay",
     "      if (decision.kind === 'reuse') {\n        throw new AppError(",
     "      if (false) {\n        throw new AppError("),

    ("an in-progress key is allowed through",
     "      if (decision.kind === 'in_progress') {\n        throw new AppError(",
     "      if (false) {\n        throw new AppError("),

    ("a failed takeover proceeds anyway",
     "      if (!took) {\n        throw new AppError(",
     "      if (false) {\n        throw new AppError("),

    ("the replay header is not sent",
     "        res.set('Idempotent-Replay', 'true');",
     "        void 'no header';"),

    ("a failure is stored and replayed",
     "    if (code >= 200 && code < 300) {",
     "    if (true) {"),

    ("a success releases instead of recording",
     "    if (code >= 200 && code < 300) {",
     "    if (false) {"),

    ("a 3xx is treated as success",
     "    if (code >= 200 && code < 300) {",
     "    if (code >= 200 && code < 400) {"),

    ("recording a response fails the response",
     "        .catch(() => undefined);\n    } else {",
     "        .then(() => { throw new Error('boom'); });\n    } else {"),

    ("a store outage runs the handler unguarded",
     "    const { claimed, existing } = await options.store.claim(scope, {",
     "    const { claimed, existing } = await options.store.claim(scope, {}) as never || await options.store.claim(scope, {"),
]


def run():
    return subprocess.run(
        ["node", os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
         "run", TEST, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True, errors="replace", timeout=300,
    )


def main():
    original = open(MW, encoding="utf-8").read()

    baseline = run()
    if baseline.returncode != 0:
        print("BASELINE FAILS")
        print(baseline.stdout[-3000:].encode("ascii", "replace").decode("ascii"))
        return 1

    print("baseline green\n")
    missed = []

    for name, old, new in MUTATIONS:
        if original.count(old) != 1:
            print("SKIP    %-56s (anchor matched %d)" % (name, original.count(old)))
            missed.append(name + " [anchor]")
            continue

        open(MW, "w", encoding="utf-8", newline="\n").write(original.replace(old, new, 1))
        try:
            verdict = "CAUGHT" if run().returncode != 0 else "MISSED"
        except subprocess.TimeoutExpired:
            verdict = "HANG"
        finally:
            open(MW, "w", encoding="utf-8", newline="\n").write(original)

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
