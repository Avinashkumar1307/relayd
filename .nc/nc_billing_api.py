"""Negative controls for the billing service and its routes."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVICE = os.path.join(ROOT, "apps", "api", "src", "services", "billing.ts")
ROUTES = os.path.join(ROOT, "apps", "api", "src", "routes", "billing.ts")

TESTS = ["apps/api/test/billing.test.ts", "apps/api/test/billing-routes.test.ts"]

MUTATIONS = [
    # ------------------------------------------------------------- the routes
    (ROUTES, "checkout drops to billing:read",
     "  router.post('/billing/checkout', ...write,",
     "  router.post('/billing/checkout', ...read,"),

    (ROUTES, "plan change drops to billing:read",
     "  router.post('/billing/plan', ...write,",
     "  router.post('/billing/plan', ...read,"),

    (ROUTES, "cancel drops to billing:read",
     "  router.post('/billing/cancel', ...write,",
     "  router.post('/billing/cancel', ...read,"),

    (ROUTES, "the portal drops to billing:read",
     "  router.post('/billing/portal', ...write,",
     "  router.post('/billing/portal', ...read,"),

    (ROUTES, "billing:write is asked for on a read",
     "  router.get('/billing', ...read,",
     "  router.get('/billing', ...write,"),

    (ROUTES, "the overview is left unauthenticated",
     "  router.get('/billing', ...read,",
     "  router.get('/billing',"),

    (ROUTES, "the pricing page requires authentication",
     "  router.get('/billing/plans', (_req: Request, res: Response) => {",
     "  router.get('/billing/plans', ...read, (_req: Request, res: Response) => {"),

    (ROUTES, "the success poll requires billing:write",
     "  router.get('/billing/checkout/status', ...read,",
     "  router.get('/billing/checkout/status', ...write,"),

    (ROUTES, "checkout validation dropped",
     "    const parsed = checkoutSchema.safeParse(req.body);\n    if (!parsed.success) {",
     "    const parsed = checkoutSchema.safeParse(req.body);\n    if (false) {"),

    (ROUTES, "the interval accepts anything",
     "const intervalSchema = z.enum(['month', 'year']);",
     "const intervalSchema = z.string() as unknown as z.ZodEnum<['month', 'year']>;"),

    (ROUTES, "validation details are dropped",
     "      throw new AppError('validation_failed', 'Invalid checkout request', 400, details(parsed.error));",
     "      throw new AppError('validation_failed', 'Invalid checkout request', 400);"),

    (ROUTES, "cancellation defaults to immediate",
     "  immediately: z.boolean().default(false),",
     "  immediately: z.boolean().default(true),"),

    (ROUTES, "the preview accepts an empty plan code",
     "    if (planCode === '') throw new AppError('validation_failed', 'planCode is required', 400);",
     "    if (false) throw new AppError('validation_failed', 'planCode is required', 400);"),

    (ROUTES, "the entitlement check refuses instead of reporting",
     "    res.json({\n      data: {\n        ...decision,\n        advisoryStatus: statusForEntitlementDenial(decision),\n      },\n    });",
     "    res.status(statusForEntitlementDenial(decision)).json({ data: decision });"),

    (ROUTES, "the entitlement check validates nothing",
     "    const parsed = usageCheckSchema.safeParse(req.query);\n    if (!parsed.success) {",
     "    const parsed = usageCheckSchema.safeParse({ feature: 'x', ...req.query });\n    if (!parsed.success) {"),

    # ------------------------------------------------------------ the service
    (SERVICE, "the catalogue offers every plan",
     "    return selfServePlans().map((plan) => ({",
     "    return PLAN_DEFINITIONS.map((plan) => ({"),

    (SERVICE, "enterprise becomes self-serve at checkout",
     "        isSelfServe: (code) => planByCode(code)?.isPublic === true,\n        ...(input.trialDays === undefined ? {} : { trialDays: input.trialDays }),",
     "        isSelfServe: () => true,\n        ...(input.trialDays === undefined ? {} : { trialDays: input.trialDays }),"),

    (SERVICE, "enterprise becomes self-serve on a plan change",
     "        isSelfServe: (code) => planByCode(code)?.isPublic === true,\n      },\n      this.options.planChangePort(scope),",
     "        isSelfServe: () => true,\n      },\n      this.options.planChangePort(scope),"),

    (SERVICE, "the success URL loses the session placeholder",
     "        successUrl: `${this.options.appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,",
     "        successUrl: `${this.options.appUrl}/billing/success`,"),

    (SERVICE, "a blocked downgrade is a 500",
     "      if (result.failure === 'plan_downgrade_blocked') {",
     "      if (false) {"),

    (SERVICE, "the conflicts are dropped from the envelope",
     "          conflictDetails(result.conflicts ?? []),",
     "          [],"),

    (SERVICE, "the conflict message loses the numbers",
     "    message: `${conflict.current.toLocaleString()} in use, ${conflict.targetLimit.toLocaleString()} allowed on that plan`,",
     "    message: 'over the limit',"),

    (SERVICE, "the conflict is not keyed by feature",
     "    path: conflict.feature,",
     "    path: 'plan',"),

    (SERVICE, "an already-subscribed workspace is a 500",
     "  if (failure === 'already_subscribed') return { code: 'conflict', status: 409 };",
     "  if (false) return { code: 'conflict', status: 409 };"),

    (SERVICE, "a provider outage becomes a 500",
     "  return { code: 'provider_unavailable', status: 502 };\n}\n\nexport function planChangeError",
     "  return { code: 'internal_error', status: 500 };\n}\n\nexport function planChangeError"),

    (SERVICE, "a missing subscription cancel becomes a 502",
     "      throw result.failure === 'no_subscription'\n        ? new AppError('not_found', 'This workspace has no subscription', 404)",
     "      throw false\n        ? new AppError('not_found', 'This workspace has no subscription', 404)"),

    (SERVICE, "an unlimited feature gets a percentage",
     "          row.included === null || row.included === 0\n            ? null",
     "          false\n            ? null"),

    (SERVICE, "the usage bar runs past a hundred",
     "            : Math.min(100, Math.round((row.used / row.included) * 100)),",
     "            : Math.round((row.used / row.included) * 100),"),

    (SERVICE, "the invoice page is unbounded",
     "    const limit = Math.min(INVOICE_PAGE, Math.max(1, Math.trunc(input.limit ?? INVOICE_PAGE)));",
     "    const limit = Math.trunc(input.limit ?? INVOICE_PAGE);"),

    (SERVICE, "a missing Stripe customer is not a 404",
     "    if (customerId === null) {",
     "    if (false) {"),

    (SERVICE, "the success poll ignores how long it has waited",
     "        action: successPollPlan(input.elapsedMs),",
     "        action: successPollPlan(0),"),


    (SERVICE, "the plan name is dropped",
     "                planName: planByCode(subscription.planCode)?.name ?? subscription.planCode,",
     "                planName: subscription.planCode,"),

    (SERVICE, "the entitlement check ignores current usage",
     "      const used = usage.find((row) => row.featureKey === input.feature)?.used ?? 0;",
     "      const used = 0;"),

    (SERVICE, "a quantity check falls back to a feature check",
     "      return input.requested === undefined\n        ? canUseFeature(input.feature, grants, state)\n        : checkUsage(input.feature, { used, requested: input.requested }, grants, state);",
     "      return canUseFeature(input.feature, grants, state);"),
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
        print(baseline.stdout[-4000:])
        return 1

    print("baseline green\n")
    missed = []

    for path, name, old, new in MUTATIONS:
        source = originals[path]
        if source.count(old) != 1:
            print("SKIP    %-52s (anchor matched %d)" % (name, source.count(old)))
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
