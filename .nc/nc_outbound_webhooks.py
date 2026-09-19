"""Negative controls for outbound webhook signing and delivery."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIG = os.path.join(ROOT, "packages", "utils", "src", "crypto", "webhook-signature.ts")
DEL = os.path.join(ROOT, "packages", "notifications", "src", "webhooks", "delivery.ts")

TESTS = [
    "packages/utils/test/webhook-signature.test.ts",
    "packages/notifications/test/webhook-delivery.test.ts",
]

MUTATIONS = [
    # ------------------------------------------------------------ signing
    (SIG, "the timestamp is left outside the MAC",
     "  const signature = hmac(input.secret, `${timestamp}.${input.body}`);",
     "  const signature = hmac(input.secret, input.body);"),

    (SIG, "the body is left outside the MAC",
     "  const signature = hmac(input.secret, `${timestamp}.${input.body}`);",
     "  const signature = hmac(input.secret, String(timestamp));"),

    (SIG, "the timestamp is milliseconds",
     "  const timestamp = Math.floor(input.at.getTime() / 1000);",
     "  const timestamp = input.at.getTime();"),

    (SIG, "verification rebuilds a different signed string",
     "  const expected = `${parsed.timestamp}.${input.body}`;",
     "  const expected = input.body;"),

    (SIG, "the replay window is not checked",
     "  if (Math.abs(now - parsed.timestamp) > tolerance) {",
     "  if (false) {"),

    (SIG, "the replay window is one-sided",
     "  if (Math.abs(now - parsed.timestamp) > tolerance) {",
     "  if (now - parsed.timestamp > tolerance) {"),

    (SIG, "the tolerance is widened to a day",
     "export const SIGNATURE_TOLERANCE_SECONDS = 300;",
     "export const SIGNATURE_TOLERANCE_SECONDS = 86_400;"),

    (SIG, "an empty secret is used for verification",
     "    if (secret.length === 0) continue;",
     "    if (false) continue;"),

    (SIG, "an empty secret list verifies everything",
     "  for (const secret of input.secrets) {",
     "  if (input.secrets.length === 0) return { valid: true };\n  for (const secret of input.secrets) {"),

    (SIG, "the comparison is not constant time",
     "    if (constantTimeEquals(hmac(secret, expected), parsed.signature)) return { valid: true };",
     "    if (hmac(secret, expected) === parsed.signature) return { valid: true };"),

    (SIG, "the length guard is removed from the comparison",
     "  if (a.length !== b.length) return false;",
     "  if (false) return false;"),

    (SIG, "a partial timestamp parse is accepted",
     "      if (!/^\\d{1,15}$/u.test(value) || !Number.isFinite(seconds)) return null;",
     "      if (!Number.isFinite(seconds)) return null;"),

    (SIG, "a signature of any shape is accepted",
     "      if (!/^[0-9a-f]{64}$/u.test(value)) return null;",
     "      if (value.length === 0) return null;"),

    (SIG, "an uppercase signature is accepted",
     "      if (!/^[0-9a-f]{64}$/u.test(value)) return null;",
     "      if (!/^[0-9a-fA-F]{64}$/u.test(value)) return null;"),

    (SIG, "a header missing a field still parses",
     "  if (timestamp === null || signature === null) return null;",
     "  if (timestamp === null && signature === null) return null;"),

    (SIG, "a malformed header is reported as a bad signature",
     "  if (parsed === null) return { valid: false, reason: 'malformed_header' };",
     "  if (parsed === null) return { valid: false, reason: 'no_matching_signature' };"),

    # ----------------------------------------------------------- delivery
    (DEL, "a 4xx is retried",
     "  if (status >= 400 && status < 500) return 'permanent_failure';",
     "  if (false) return 'permanent_failure';"),

    (DEL, "429 is treated as permanent",
     "  if (status === 408 || status === 429) return 'retry';",
     "  if (status === 408) return 'retry';"),

    (DEL, "408 is treated as permanent",
     "  if (status === 408 || status === 429) return 'retry';",
     "  if (status === 429) return 'retry';"),

    (DEL, "a network error is treated as permanent",
     "  if (status === null) return 'retry';",
     "  if (status === null) return 'permanent_failure';"),

    (DEL, "a 3xx is treated as delivered",
     "  if (status >= 200 && status < 300) return 'delivered';",
     "  if (status >= 200 && status < 400) return 'delivered';"),

    (DEL, "backoff does not grow",
     "  const uncapped = base * 2 ** Math.min(exponent, 30);",
     "  const uncapped = base;"),

    (DEL, "backoff is not capped",
     "  const capped = Math.min(max, uncapped);",
     "  const capped = uncapped;"),

    (DEL, "jitter is added rather than spread",
     "  const floor = Math.min(base, capped);\n  return Math.round(floor + random() * (capped - floor));",
     "  return Math.round(capped + random() * base);"),

    (DEL, "there is no jitter at all",
     "  return Math.round(floor + random() * (capped - floor));",
     "  return Math.round(capped);"),

    (DEL, "a nonsense attempt underflows the exponent",
     "  const exponent = Math.max(0, Math.trunc(attempt) - 1);",
     "  const exponent = Math.trunc(attempt) - 1;"),

    (DEL, "a success does not clear the failure count",
     "    return { status: 'active', consecutiveFailures: 0 };",
     "    return { status: 'active', consecutiveFailures: current.consecutiveFailures };"),

    (DEL, "a paused endpoint is reactivated",
     "  if (current.status === 'paused' || current.status === 'disabled') return current;",
     "  if (current.status === 'disabled') return current;"),

    (DEL, "a disabled endpoint is reactivated",
     "  if (current.status === 'paused' || current.status === 'disabled') return current;",
     "  if (current.status === 'paused') return current;"),

    (DEL, "the failing threshold is off by one",
     "  if (failures >= failing) return { status: 'failing', consecutiveFailures: failures };",
     "  if (failures > failing) return { status: 'failing', consecutiveFailures: failures };"),

    (DEL, "an endpoint is disabled on the first few failures",
     "export const DISABLE_THRESHOLD = 50;",
     "export const DISABLE_THRESHOLD = 5;"),

    (DEL, "an endpoint is never disabled",
     "  if (failures >= disable) return { status: 'disabled', consecutiveFailures: failures };",
     "  if (false) return { status: 'disabled', consecutiveFailures: failures };"),

    (DEL, "a permanent failure does not count against the endpoint",
     "  const failures = current.consecutiveFailures + 1;",
     "  const failures = outcome === 'permanent_failure' ? current.consecutiveFailures : current.consecutiveFailures + 1;"),

    (DEL, "a failing endpoint stops receiving events",
     "  if (input.status !== 'active' && input.status !== 'failing') return false;",
     "  if (input.status !== 'active') return false;"),

    (DEL, "a paused endpoint keeps receiving events",
     "  if (input.status !== 'active' && input.status !== 'failing') return false;",
     "  if (input.status === 'disabled') return false;"),

    (DEL, "the wildcard subscription stops working",
     "  return input.subscribedEvents.includes('*') || input.subscribedEvents.includes(input.eventType);",
     "  return input.subscribedEvents.includes(input.eventType);"),

    (DEL, "every endpoint receives every event",
     "  return input.subscribedEvents.includes('*') || input.subscribedEvents.includes(input.eventType);",
     "  return true;"),

    (DEL, "the previous secret never expires",
     "  if (input.now.getTime() - input.rotatedAt.getTime() < overlap) {",
     "  if (true) {"),

    (DEL, "the previous secret is dropped immediately",
     "  if (input.now.getTime() - input.rotatedAt.getTime() < overlap) {",
     "  if (false) {"),

    (DEL, "deliveries sign with the old secret first",
     "  const secrets = [input.secret];",
     "  const secrets = [input.previousSecret ?? input.secret];"),

    (DEL, "the event id changes between attempts",
     "  const body = JSON.stringify({\n    id: input.eventId,",
     "  const body = JSON.stringify({\n    id: `${input.eventId}-${input.attempt}`,"),

    (DEL, "the event id is not sent as a header",
     "      [EVENT_ID_HEADER]: input.eventId,",
     "      'x-nothing': input.eventId,"),

    (DEL, "the signature is computed over something else",
     "  const signed = signWebhook({ body, secret: input.secret, at: input.at });",
     "  const signed = signWebhook({ body: '{}', secret: input.secret, at: input.at });"),

    (DEL, "the secret leaks into a header",
     "      'user-agent': 'Relayd/1.0',",
     "      'user-agent': `Relayd/1.0 ${input.secret}`,"),

    (DEL, "a permanent failure is retried anyway",
     "  if (input.outcome === 'permanent_failure') {",
     "  if (false) {"),

    (DEL, "the attempt limit is ignored",
     "  if (attempt >= maxAttempts) {",
     "  if (false) {"),

    (DEL, "the attempt limit is off by one",
     "  if (attempt >= maxAttempts) {",
     "  if (attempt > maxAttempts) {"),

    (DEL, "a success schedules a retry",
     "  if (input.outcome === 'delivered') {",
     "  if (false) {"),

    (DEL, "a long response body is stored whole",
     "  if (body.length <= limit) return body;",
     "  if (true) return body;"),
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
        print(baseline.stdout[-4000:].encode("ascii", "replace").decode("ascii"))
        return 1

    print("baseline green\n")
    missed = []

    for path, name, old, new in MUTATIONS:
        source = originals[path]
        if source.count(old) != 1:
            print("SKIP    %-56s (anchor matched %d)" % (name, source.count(old)))
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
