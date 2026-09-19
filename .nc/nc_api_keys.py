"""Negative controls for API keys, their auth middleware and the rate limiter."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SERVICE = os.path.join(ROOT, "apps", "api", "src", "services", "api-keys.ts")
AUTH = os.path.join(ROOT, "apps", "api", "src", "middleware", "api-key-auth.ts")
LIMIT = os.path.join(ROOT, "apps", "api", "src", "middleware", "rate-limit.ts")

TESTS = [
    "apps/api/test/api-keys.test.ts",
    "apps/api/test/api-key-auth.test.ts",
    "apps/api/test/rate-limit.test.ts",
]

MUTATIONS = [
    # ----------------------------------------------------------- the service
    (SERVICE, "billing:write becomes grantable",
     "    const { refused: forbidden } = partitionApiKeyScopes(requested);\n    if (forbidden.length > 0) {",
     "    const { refused: forbidden } = partitionApiKeyScopes(requested);\n    if (false) {"),

    (SERVICE, "a forbidden scope is silently dropped instead of refused",
     "    const { refused: forbidden } = partitionApiKeyScopes(requested);\n    if (forbidden.length > 0) {\n      throw new AppError(",
     "    const { allowed: kept, refused: forbidden } = partitionApiKeyScopes(requested);\n    requested.length = 0;\n    requested.push(...kept);\n    if (false && forbidden.length > 0) {\n      throw new AppError("),

    (SERVICE, "a key may exceed the minting role",
     "    const beyond = requested.filter((permission) => !can(input.actor.role, permission));\n    if (beyond.length > 0) {",
     "    const beyond = requested.filter((permission) => !can(input.actor.role, permission));\n    if (false) {"),

    (SERVICE, "a scopeless key is issued",
     "    if (requested.length === 0) {",
     "    if (false) {"),

    (SERVICE, "the key is stored rather than its hash",
     "        keyHash: hashToken(key),",
     "        keyHash: Buffer.from(key, 'utf8'),"),

    (SERVICE, "the key lands in the audit trail",
     "          after: { name: input.name, scopes: requested, expiresAt },",
     "          after: { name: input.name, scopes: requested, expiresAt, key },"),

    (SERVICE, "the key lands in the returned row",
     "      return { key, row: toPublic(row) };",
     "      return { key, row: { ...toPublic(row), name: key } };"),

    (SERVICE, "the whole key becomes the visible prefix",
     "        keyPrefix: lookup,",
     "        keyPrefix: key,"),

    (SERVICE, "the active-key cap is removed",
     "      if (cap !== null && (await repos.apiKeys.countActive(scope)) >= cap) {",
     "      if (false) {"),

    (SERVICE, "expiry defaults to never",
     "  const requested = days ?? MAX_KEY_LIFETIME_DAYS;\n  if (!Number.isFinite(requested) || requested <= 0) return null;",
     "  const requested = days ?? 0;\n  if (!Number.isFinite(requested) || requested <= 0) return null;"),

    (SERVICE, "expiry is not capped",
     "  const bounded = Math.min(MAX_KEY_LIFETIME_DAYS, Math.floor(requested));",
     "  const bounded = Math.floor(requested);"),

    (SERVICE, "the lifetime cap is lengthened",
     "export const MAX_KEY_LIFETIME_DAYS = 365;",
     "export const MAX_KEY_LIFETIME_DAYS = 3650;"),

    (SERVICE, "unknown scopes are kept",
     "    if (!known.has(scope) || seen.has(scope)) continue;",
     "    if (seen.has(scope)) continue;"),

    (SERVICE, "duplicate scopes are kept",
     "    if (!known.has(scope) || seen.has(scope)) continue;",
     "    if (!known.has(scope)) continue;"),

    (SERVICE, "grantable scopes include the forbidden ones",
     "      (permission) => canApiKeyHold(permission) && can(role, permission),",
     "      (permission) => can(role, permission),"),

    (SERVICE, "grantable scopes ignore the role",
     "      (permission) => canApiKeyHold(permission) && can(role, permission),",
     "      (permission) => canApiKeyHold(permission),"),

    (SERVICE, "revoking a key from another workspace succeeds",
     "      if (existing === null) throw new AppError('not_found', 'Not found', 404);",
     "      if (false) throw new AppError('not_found', 'Not found', 404);"),

    (SERVICE, "a second revoke writes another audit row",
     "      if (revoked) {\n        await repos.auditLogs.append(",
     "      if (true) {\n        await repos.auditLogs.append("),

    # -------------------------------------------------------------- the auth
    (AUTH, "a session token is accepted as a key",
     "export function isApiKeyCredential(header: string | undefined): boolean {\n  if (header === undefined || !header.startsWith(BEARER)) return false;\n  return header.slice(BEARER.length).startsWith(KEY_PREFIX);",
     "export function isApiKeyCredential(header: string | undefined): boolean {\n  if (header === undefined || !header.startsWith(BEARER)) return false;\n  return true;"),

    (AUTH, "the shape check is skipped",
     "    if (!KEY_SHAPE.test(credential)) {",
     "    if (false) {"),

    (AUTH, "a revoked key still works",
     "    if (resolved.revokedAt !== null) {",
     "    if (false) {"),

    (AUTH, "an expired key still works",
     "    if (resolved.expiresAt !== null && resolved.expiresAt.getTime() <= at.getTime()) {",
     "    if (false) {"),

    (AUTH, "expiry is off by a direction",
     "    if (resolved.expiresAt !== null && resolved.expiresAt.getTime() <= at.getTime()) {",
     "    if (resolved.expiresAt !== null && resolved.expiresAt.getTime() > at.getTime()) {"),

    (AUTH, "a mismatched workspace header is ignored",
     "    if (requested !== undefined && requested.length > 0 && requested !== resolved.workspaceId) {",
     "    if (false) {"),

    (AUTH, "the workspace comes from somewhere other than the key",
     "      scope: workspaceScope(resolved.workspaceId as WorkspaceId),",
     "      scope: workspaceScope('ws-somewhere-else' as WorkspaceId),"),

    (AUTH, "a key is recorded as a user",
     "    setApiKeyPrincipal({",
     "    if (false) setApiKeyPrincipal({"),

    (AUTH, "a key gets a role rather than its scopes",
     "      role: 'viewer',\n      permissions: scopes,",
     "      role: 'owner',\n      permissions: scopes,"),

    (AUTH, "a key carries every permission",
     "      permissions: scopes,",
     "      permissions: PERMISSIONS,"),

    (AUTH, "the forbidden set is not re-applied at auth time",
     "  return stored.filter(\n    (scope): scope is Permission => known.has(scope) && canApiKeyHold(scope as Permission),\n  );",
     "  return stored.filter((scope): scope is Permission => known.has(scope));"),

    (AUTH, "an unknown stored scope still works",
     "  return stored.filter(\n    (scope): scope is Permission => known.has(scope) && canApiKeyHold(scope as Permission),\n  );",
     "  return stored as Permission[];"),

    (AUTH, "the scope check passes anything",
     "    if (!apiKey.scopes.includes(permission)) {",
     "    if (false) {"),

    (AUTH, "a key falls through to the user check",
     "    const apiKey = tryGetApiKeyPrincipal();\n\n    if (apiKey === undefined) {\n      userCheck(req, res, next);\n      return;\n    }",
     "    const apiKey = tryGetApiKeyPrincipal();\n\n    if (true) {\n      userCheck(req, res, next);\n      return;\n    }\n    void apiKey;"),

    (AUTH, "key-only routes stop refusing keys",
     "    if (tryGetApiKeyPrincipal() !== undefined) {",
     "    if (false) {"),

    (AUTH, "a failed touch fails the request",
     "      void options.touch(resolved.id, at).catch(() => undefined);",
     "      await options.touch(resolved.id, at);"),

    (AUTH, "the key is touched on every request",
     "    if (options.touch !== undefined && (options.shouldTouch?.(resolved.lastUsedAt, at) ?? false)) {",
     "    if (options.touch !== undefined) {"),

    # ------------------------------------------------------------- the limit
    (LIMIT, "the previous window is ignored",
     "  const estimate = input.currentCount + input.previousCount * (1 - elapsed);",
     "  const estimate = input.currentCount;"),

    (LIMIT, "the previous window is never forgotten",
     "  const estimate = input.currentCount + input.previousCount * (1 - elapsed);",
     "  const estimate = input.currentCount + input.previousCount;"),

    (LIMIT, "the limit is off by one, generous",
     "  if (estimate < limit) {",
     "  if (estimate <= limit) {"),

    (LIMIT, "the limit is off by one, mean",
     "  if (estimate < limit) {",
     "  if (estimate < limit - 1) {"),

    (LIMIT, "retry-after may be zero",
     "    retryAfterSeconds: Math.max(1, remainingWindow),",
     "    retryAfterSeconds: remainingWindow,"),

    (LIMIT, "the remainder rounds in the caller's favour",
     "  const remaining = limit - Math.ceil(estimate);",
     "  const remaining = limit - Math.floor(estimate);"),

    (LIMIT, "the elapsed fraction is not clamped",
     "  const elapsed = Math.min(1, Math.max(0, input.elapsedFraction));",
     "  const elapsed = input.elapsedFraction;"),

    (LIMIT, "the limiter fails closed",
     "    } catch {\n      // Fails open. See the note at the top: this protects our capacity, and\n      // a cache outage must not become a product outage.\n      next();\n      return;\n    }",
     "    } catch {\n      next(new AppError('rate_limited', 'x', 429));\n      return;\n    }"),

    (LIMIT, "headers are set only on a refusal",
     "    res.set('X-RateLimit-Limit', String(decision.limit));\n    res.set('X-RateLimit-Remaining', String(decision.remaining));",
     "    if (!decision.allowed) {\n      res.set('X-RateLimit-Limit', String(decision.limit));\n      res.set('X-RateLimit-Remaining', String(decision.remaining));\n    }"),

    (LIMIT, "the plan multiplier is ignored",
     "    const multiplier = Math.max(1, options.multiplier?.(req) ?? 1);",
     "    const multiplier = 1;"),

    (LIMIT, "the multiplier can shrink the budget",
     "    const multiplier = Math.max(1, options.multiplier?.(req) ?? 1);",
     "    const multiplier = options.multiplier?.(req) ?? 1;"),

    (LIMIT, "a null key still counts",
     "    if (key === null) {\n      next();\n      return;\n    }",
     "    if (false) {\n      next();\n      return;\n    }"),

    (LIMIT, "the user budget is raised",
     "  user: { limit: 100, windowSeconds: 60 },",
     "  user: { limit: 10_000, windowSeconds: 60 },"),

    (LIMIT, "the API key budget is raised",
     "  apiKey: { limit: 1_000, windowSeconds: 60 },",
     "  apiKey: { limit: 100_000, windowSeconds: 60 },"),

    (LIMIT, "the password reset budget is raised",
     "  passwordReset: { limit: 5, windowSeconds: 3_600 },",
     "  passwordReset: { limit: 500, windowSeconds: 3_600 },"),

    (LIMIT, "an empty IP is counted as a bucket",
     "    return ip === undefined || ip.length === 0 ? null : `rl:${prefix}:${ip}`;",
     "    return `rl:${prefix}:${ip ?? ''}`;"),
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
