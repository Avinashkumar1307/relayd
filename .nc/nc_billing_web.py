"""Negative controls for apps/web/src/routes/billing/billing.tsx."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "apps", "web", "src", "routes", "billing", "billing.tsx")
TEST = "apps/web/test/billing-pages.test.tsx"

MUTATIONS = [
    ("an unlimited feature gets a full bar",
     "          {row.percentUsed !== null && (",
     "          {true && ("),

    ("no feature gets a bar",
     "          {row.percentUsed !== null && (",
     "          {false && ("),

    ("the bar reports the wrong value",
     "              aria-valuenow={row.percentUsed}",
     "              aria-valuenow={100}"),

    ("overage is hidden",
     "          {row.overage > 0 && (",
     "          {false && ("),

    ("overage is announced when there is none",
     "          {row.overage > 0 && (",
     "          {true && ("),

    ("the past-due banner disappears",
     "  if (state.pastDue) {",
     "  if (false) {"),

    ("a suspended subscription shows the past-due banner",
     "  if (state.subscriptionSuspended) {",
     "  if (false) {"),

    ("a suspended workspace is told to pay",
     "  if (state.workspaceSuspended) {",
     "  if (false) {"),

    ("a banner appears when nothing is wrong",
     "  // Nothing to say. A banner that appears when everything is fine teaches\n  // people to ignore banners.\n  return null;",
     "  return (\n    <div role=\"alert\" className=\"p-4\">Everything is fine.</div>\n  );"),

    ("the suspension promise is dropped",
     "          Nothing has been deleted. Update your card and sending resumes, including anything\n          scheduled while you were behind.",
     "          Update your card to continue."),

    ("the scheduled change is not explained",
     "          {subscription.scheduledPlanCode !== null && (",
     "          {false && ("),

    ("the card number is rendered in full",
     "                  : `${paymentMethod.brand ?? 'Card'} ending ${paymentMethod.last4}`}",
     "                  : `${paymentMethod.brand ?? 'Card'}`}"),

    ("the plan already held is offered again",
     "        {isCurrent ? (\n          <Badge tone=\"good\">Current plan</Badge>",
     "        {false ? (\n          <Badge tone=\"good\">Current plan</Badge>"),

    ("unlimited renders as a number",
     "              {limit === null ? 'Unlimited' : limit.toLocaleString()}",
     "              {String(limit)}"),

    ("the downgrade blockers are not listed",
     "        {preview.data?.blocked === true && (",
     "        {false && ("),

    ("a blocked downgrade can still be confirmed",
     "            disabled={preview.data?.blocked !== false || change.isPending}",
     "            disabled={change.isPending}"),

    ("nothing can be confirmed",
     "            disabled={preview.data?.blocked !== false || change.isPending}",
     "            disabled={true}"),

    ("the blocked list loses the numbers",
     "            {featureLabel(conflict.feature)}: {conflict.current.toLocaleString()} in use,{' '}\n            {conflict.targetLimit.toLocaleString()} allowed",
     "            {featureLabel(conflict.feature)} is over the limit"),

    ("the success page trusts the redirect",
     "  if (done) {",
     "  if (true) {"),

    ("the success page never finishes",
     "  if (done) {\n    return (\n      <Page title=\"You are all set\"",
     "  if (false) {\n    return (\n      <Page title=\"You are all set\""),

    ("giving up shows a spinner instead of an explanation",
     "  if (action === 'give_up') {",
     "  if (false) {"),

    ("giving up loses the session reference",
     "            <code className=\"font-mono\">{params.get('session_id') ?? 'unknown'}</code>",
     "            <code className=\"font-mono\">unknown</code>"),

    ("giving up no longer says the payment worked",
     "            Your payment succeeded, and we are still waiting for our payment provider to confirm\n            it. Nothing is lost and you will not be charged twice.",
     "            Something went wrong."),

    ("the fallback message stops reassuring",
     "          ? 'Taking a little longer than usual. Still working — your payment has gone through.'",
     "          ? 'Still working.'"),

    ("the invoice link loses noopener",
     "                  rel=\"noreferrer noopener\"",
     "                  rel=\"noreferrer\""),

    ("an empty invoice list renders a table",
     "  if (query.data.length === 0) {",
     "  if (false) {"),

    ("cancellation defaults to immediate",
     "  const [immediately, setImmediately] = useState(false);",
     "  const [immediately, setImmediately] = useState(true);"),

    ("the cost of immediate cancellation is not stated",
     "              Sending stops now. The rest of this period is not refunded, and undoing it means\n              subscribing again.",
     "              Sending stops now."),

    ("there is no way out of the cancel page",
     "          <Link to=\"/billing\">\n            <Button variant=\"secondary\">Keep my plan</Button>\n          </Link>",
     "          <span />"),

    ("an unknown currency crashes the page",
     "  } catch {\n    // An unknown currency code from a Stripe account configured for one we do\n    // not recognise. Better a bare number than a crash on the billing page.\n    return `${amount.toFixed(2)} ${currency.toUpperCase()}`;\n  }",
     "  } finally {\n    // nothing\n  }"),

    ("an unlabelled feature renders as nothing",
     "  return labels[key] ?? key;",
     "  return labels[key] ?? '';"),
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
