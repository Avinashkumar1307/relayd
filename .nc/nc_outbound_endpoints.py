"""Negative controls for outbound webhook endpoint management."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "apps", "api", "src", "services", "outbound-webhooks.ts")
TEST = "apps/api/test/outbound-webhooks.test.ts"

MUTATIONS = [
    ("http is accepted",
     "  if (url.protocol !== 'https:') {",
     "  if (false) {"),

    ("private hosts are accepted",
     "  if (isPrivateHost(url.hostname)) {",
     "  if (false) {"),

    ("credentials in the URL are accepted",
     "  if (url.username !== '' || url.password !== '') {",
     "  if (false) {"),

    ("an unparseable URL is accepted",
     "    throw new AppError('validation_failed', 'That is not a valid URL', 400);",
     "    return;"),

    ("localhost is allowed",
     "  if (host === 'localhost' || host.endsWith('.localhost')) return true;",
     "  if (false) return true;"),

    ("the metadata address is allowed",
     "  if (a === 169 && b === 254) return true;",
     "  if (false) return true;"),

    ("the 10/8 range is allowed",
     "  if (a === 127 || a === 0 || a === 10) return true;",
     "  if (a === 127 || a === 0) return true;"),

    ("loopback is allowed",
     "  if (a === 127 || a === 0 || a === 10) return true;",
     "  if (a === 0 || a === 10) return true;"),

    ("the 172.16/12 range is widened to the whole of 172",
     "  if (a === 172 && b >= 16 && b <= 31) return true;",
     "  if (a === 172) return true;"),

    ("the 172.16/12 range is dropped",
     "  if (a === 172 && b >= 16 && b <= 31) return true;",
     "  if (false) return true;"),

    ("192.168 is allowed",
     "  if (a === 192 && b === 168) return true;",
     "  if (false) return true;"),

    ("192.169 is refused as though it were private",
     "  if (a === 192 && b === 168) return true;",
     "  if (a === 192) return true;"),

    ("IPv6 loopback is allowed",
     "  if (host === '::1') return true;",
     "  if (false) return true;"),

    ("unique-local IPv6 is allowed",
     "  if (/^f[cd][0-9a-f]{2}:/u.test(host)) return true;",
     "  if (false) return true;"),

    ("internal suffixes are allowed",
     "  if (host.endsWith('.internal') || host.endsWith('.local')) return true;",
     "  if (false) return true;"),

    ("the host check is case-sensitive",
     "  const host = hostname.toLowerCase().replace(/^\\[|\\]$/gu, '');",
     "  const host = hostname.replace(/^\\[|\\]$/gu, '');"),

    ("unknown event types are kept",
     "    if (!known.has(event) || seen.has(event)) continue;",
     "    if (seen.has(event)) continue;"),

    ("duplicate event types are kept",
     "    if (!known.has(event) || seen.has(event)) continue;",
     "    if (!known.has(event)) continue;"),

    ("a wildcard is stored alongside the rest",
     "  return out.includes('*') ? ['*'] : out;",
     "  return out;"),

    ("an empty subscription is accepted",
     "  if (out.length === 0) {",
     "  if (false) {"),

    ("the endpoint cap is removed",
     "      if ((await repos.webhooks.list(scope)).length >= MAX_ENDPOINTS) {",
     "      if (false) {"),
    ("the secret is stored rather than its ARN",
     "        secretRef: ref,\n        events,",
     "        secretRef: secret,\n        events,"),

    ("rotation stores the secret rather than its ARN",
     "        secretRef: ref,\n        at: this.now(),",
     "        secretRef: secret,\n        at: this.now(),"),


    ("the ARN is returned to the caller",
     "      return { endpoint: toPublic(row), secretShownOnce: secret };\n    });\n  }\n\n  async update(",
     "      return { endpoint: { ...toPublic(row), description: row.secretRef }, secretShownOnce: secret };\n    });\n  }\n\n  async update("),

    ("the secret lands in the audit trail",
     "          after: { url: input.url, events },",
     "          after: { url: input.url, events, secret },"),

    ("the URL is checked after the secret is stored",
     "    assertDeliverableUrl(input.url);\n    const events = normaliseEvents(input.events);",
     "    const events = normaliseEvents(input.events);"),

    ("an updated URL is not checked",
     "    if (input.url !== undefined) assertDeliverableUrl(input.url);",
     "    if (false) assertDeliverableUrl(input.url as string);"),

    ("a missing endpoint is updated anyway",
     "      const existing = await repos.webhooks.find(scope, input.endpointId);\n      if (existing === null) throw new AppError('not_found', 'Not found', 404);\n\n      const row = await repos.webhooks.update(scope, {",
     "      const existing = await repos.webhooks.find(scope, input.endpointId);\n      if (false) throw new AppError('not_found', 'Not found', 404);\n\n      const row = await repos.webhooks.update(scope, {"),

    ("a missing endpoint is rotated anyway",
     "      const existing = await repos.webhooks.find(scope, input.endpointId);\n      if (existing === null) throw new AppError('not_found', 'Not found', 404);\n\n      const { ref, secret } = await this.options.storeSecret({",
     "      const existing = await repos.webhooks.find(scope, input.endpointId);\n      if (false) throw new AppError('not_found', 'Not found', 404);\n\n      const { ref, secret } = await this.options.storeSecret({"),

    ("the delivery log skips the ownership check",
     "      if ((await repos.webhooks.find(scope, input.endpointId)) === null) {",
     "      if (false) {"),

    ("the delivery page is unbounded",
     "    const limit = Math.min(100, Math.max(1, Math.trunc(input.limit ?? 50)));",
     "    const limit = Math.trunc(input.limit ?? 50);"),

    ("the update records no before state",
     "          before: { url: existing.url, events: existing.events, status: existing.status },",
     "          before: {},"),
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
        print(baseline.stdout[-3000:].encode("ascii", "replace").decode("ascii"))
        return 1

    print("baseline green\n")
    missed = []

    for name, old, new in MUTATIONS:
        if original.count(old) != 1:
            print("SKIP    %-56s (anchor matched %d)" % (name, original.count(old)))
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
