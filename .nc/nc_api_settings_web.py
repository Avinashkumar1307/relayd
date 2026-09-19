"""Negative controls for apps/web/src/routes/settings/api.tsx."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "apps", "web", "src", "routes", "settings", "api.tsx")
TEST = "apps/web/test/api-settings.test.tsx"

MUTATIONS = [
    ("the reveal stops saying it is the only time",
     "          Copy this now. We store only a hash of it, so we cannot show it to you again — not here,\n          and not if you ask support.",
     "          Here is your credential."),

    ("the reveal shows nothing",
     "      <code className=\"block overflow-x-auto rounded border border-emerald-200 bg-white px-3 py-2 font-mono text-xs text-slate-900\">\n        {value}\n      </code>",
     "      <code />"),

    ("a revoked key is hidden from the list",
     "      {keys.data !== undefined && keys.data.length > 0 && (",
     "      {false && ("),

    ("a revoked key loses its badge",
     "        {revoked && (\n          <span className=\"ml-2\">\n            <Badge tone=\"bad\">Revoked {formatDate(apiKey.revokedAt)}</Badge>\n          </span>\n        )}",
     "        {false && (\n          <span className=\"ml-2\">\n            <Badge tone=\"bad\">Revoked {formatDate(apiKey.revokedAt)}</Badge>\n          </span>\n        )}"),

    ("a revoked key can be revoked again",
     "        {!revoked &&",
     "        {true &&"),

    ("revoking needs no confirmation",
     "          (confirming ? (",
     "          (true ? ("),

    ("the whole key is shown in the list",
     "        <code className=\"font-mono text-xs\">{apiKey.keyPrefix}…</code>",
     "        <code className=\"font-mono text-xs\">{apiKey.keyPrefix}</code>"),

    ("the empty state disappears",
     "      {keys.data?.length === 0 && (",
     "      {false && ("),

    ("the scope list is not the grantable one",
     "            {scopes.data.scopes.map((scope) => (",
     "            {['contact:read', 'billing:write'].map((scope) => ("),

    ("a key can be created with no scopes",
     "            disabled={name.trim() === '' || selected.length === 0 || create.isPending}",
     "            disabled={create.isPending}"),

    ("a key can be created with no name",
     "            disabled={name.trim() === '' || selected.length === 0 || create.isPending}",
     "            disabled={selected.length === 0 || create.isPending}"),

    ("the disabled-endpoint explanation is dropped",
     "      {endpoint.status === 'disabled' && (",
     "      {false && ("),

    ("the disabled reason is not shown",
     "            {endpoint.disabledReason ??\n              'It failed too many times in a row.'}{' '}",
     "            {' '}"),

    ("the disabled panel stops saying events are not resent",
     "            Fix it and choose Resume — nothing that happened while it was disabled is resent.",
     "            Fix it and choose Resume."),

    ("the failing warning is dropped",
     "      {endpoint.status === 'failing' && (",
     "      {false && ("),

    ("a disabled endpoint offers Pause",
     "          {endpoint.status === 'paused' || endpoint.status === 'disabled' ? 'Resume' : 'Pause'}",
     "          {endpoint.status === 'paused' ? 'Resume' : 'Pause'}"),

    ("the rotation overlap is not explained",
     "      {endpoint.secretRotatedAt !== null && (",
     "      {false && ("),

    ("the rotation note loses the window",
     "          Secret rotated {formatDate(endpoint.secretRotatedAt)}. The previous secret keeps working\n          for 24 hours, so you can deploy without a gap.",
     "          Secret rotated {formatDate(endpoint.secretRotatedAt)}."),

    ("the signature scheme is not described",
     "          <p>\n            Verify the <code className=\"font-mono\">Relayd-Signature</code> header with this. We\n            sign <code className=\"font-mono\">{'{timestamp}.{body}'}</code> with HMAC-SHA256 and\n            send it as <code className=\"font-mono\">t=…,v1=…</code>.\n          </p>",
     "          <p>Use this to verify deliveries.</p>"),

    ("the rotated secret is not revealed",
     "    onSuccess: async (result) => {\n      await invalidate();\n      onRotated({ url: result.url, value: result.secretShownOnce });\n    },",
     "    onSuccess: async () => {\n      await invalidate();\n    },"),

    ("the delivery response is hidden",
     "            {delivery.responseCode ?? delivery.error ?? '—'}",
     "            {'—'}"),

    ("the attempt count is hidden",
     "          <Cell muted>{delivery.attempt}</Cell>",
     "          <Cell muted>{'—'}</Cell>"),

    ("the empty delivery list renders a table",
     "  if (deliveries.data.length === 0) {",
     "  if (false) {"),

    ("the https requirement is not stated",
     "            Must be https and reachable from the internet.",
     "            Where to send events."),

    ("the wildcard option disappears",
     "                checked={selected.includes('*')}\n                onChange={(event) => setSelected(event.target.checked ? ['*'] : [])}\n              />\n              <span>Everything, including events we add later</span>",
     "                checked={false}\n                onChange={() => undefined}\n              />\n              <span>Nothing</span>"),

    ("individual types stay enabled under a wildcard",
     "                  disabled={selected.includes('*')}",
     "                  disabled={false}"),

    ("a create error is swallowed",
     "        {create.isError && (\n          <p role=\"alert\" className=\"text-sm text-red-700\">\n            {create.error instanceof ApiError ? create.error.message : 'That did not work.'}\n          </p>\n        )}\n\n        <div className=\"flex justify-end gap-2\">\n          <Button variant=\"secondary\" onClick={onClose}>\n            Cancel\n          </Button>\n          <Button\n            onClick={() => create.mutate()}\n            disabled={url.trim() === '' || selected.length === 0 || create.isPending}",
     "        {false && (\n          <p role=\"alert\" className=\"text-sm text-red-700\">\n            {create.error instanceof ApiError ? create.error.message : 'That did not work.'}\n          </p>\n        )}\n\n        <div className=\"flex justify-end gap-2\">\n          <Button variant=\"secondary\" onClick={onClose}>\n            Cancel\n          </Button>\n          <Button\n            onClick={() => create.mutate()}\n            disabled={url.trim() === '' || selected.length === 0 || create.isPending}"),
]


def run():
    return subprocess.run(
        ["node", os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
         "run", TEST, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True, errors="replace", timeout=400,
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
