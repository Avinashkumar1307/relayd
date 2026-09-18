"""Negative controls for apps/edge/src/routes/billing-webhook.ts."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "apps", "edge", "src", "routes", "billing-webhook.ts")
TEST = "apps/edge/test/billing-webhook.test.ts"

MUTATIONS = [
    ("an unsigned request accepted",
     "      if (signature === null) {",
     "      if (false) {"),

    ("a signature array accepted by picking one",
     "  if (typeof raw === 'string' && raw.length > 0) return raw;",
     "  if (typeof raw === 'string' && raw.length > 0) return raw;\n  if (Array.isArray(raw) && raw[0] !== undefined) return String(raw[0]);"),

    ("an empty signature accepted",
     "  if (typeof raw === 'string' && raw.length > 0) return raw;",
     "  if (typeof raw === 'string') return raw;"),

    ("a failed verification accepted",
     "      if (event === null) {",
     "      if (false) {"),

    ("a throwing verifier crashes rather than refusing",
     "      } catch {\n        event = null;\n      }",
     "      } finally {\n        // nothing\n      }"),

    ("the body is JSON-parsed before verification",
     "  const rawBody = express.raw({ type: '*/*', limit: deps.maxBodyBytes ?? DEFAULT_MAX_BODY });",
     "  const rawBody = express.json({ limit: deps.maxBodyBytes ?? DEFAULT_MAX_BODY });"),

    ("the body size limit is ignored",
     "  const rawBody = express.raw({ type: '*/*', limit: deps.maxBodyBytes ?? DEFAULT_MAX_BODY });",
     "  const rawBody = express.raw({ type: '*/*' });"),

    ("the object is marked before the inbox write",
     "      const inserted = await deps.insertInboxEvent({",
     "      if (event.objectType !== null && event.providerObjectId !== null) {\n        await deps.markDirty({\n          objectType: event.objectType,\n          providerObjectId: event.providerObjectId,\n          workspaceId: event.workspaceId,\n        });\n      }\n      const inserted = await deps.insertInboxEvent({"),

    ("a redelivery marks the object again",
     "      if (!inserted) {",
     "      if (false) {"),

    ("a redelivery answers 409",
     "        res.status(200).json({ data: { received: true, duplicate: true } });",
     "        res.status(409).json({ data: { received: true, duplicate: true } });"),

    ("an event about nothing is refused",
     "      if (event.objectType === null || event.providerObjectId === null) {\n        // An event about nothing we mirror",
     "      if (false) {\n        // An event about nothing we mirror"),

    ("an event about nothing is marked anyway",
     "        res.status(200).json({ data: { received: true, marked: false } });\n        return;\n      }",
     "        res.status(200).json({ data: { received: true, marked: false } });\n      }"),

    ("an unattributed event is dropped",
     "      const inserted = await deps.insertInboxEvent({\n        providerEventId: event.providerEventId,",
     "      if (event.workspaceId === null) {\n        res.status(200).json({ data: { received: true } });\n        return;\n      }\n      const inserted = await deps.insertInboxEvent({\n        providerEventId: event.providerEventId,"),

    ("the object is never marked",
     "      await deps.markDirty({\n        objectType: event.objectType,",
     "      if (false) await deps.markDirty({\n        objectType: event.objectType,"),

    ("a missing signature answers 200",
     "        res.status(400).json({ error: { code: 'bad_request', message: 'Missing signature' } });",
     "        res.status(200).json({ error: { code: 'bad_request', message: 'Missing signature' } });"),

    ("an invalid signature answers 200",
     "        res\n          .status(401)\n          .json({ error: { code: 'unauthenticated', message: 'Invalid signature' } });",
     "        res\n          .status(200)\n          .json({ error: { code: 'unauthenticated', message: 'Invalid signature' } });"),
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
