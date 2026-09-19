"""Negative controls for the Phase 10 observability work.

Covers:
  packages/testing/test/observability.test.ts
  packages/testing/test/trace-chain.test.ts
  packages/testing/test/terraform-policy.isolation.test.ts
  packages/logger/test/sentry-init.test.ts
  apps/api/test/metrics.test.ts

Run: python3 .nc/nc_observability.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = [
    "packages/testing/test/observability.test.ts",
    "packages/testing/test/trace-chain.test.ts",
    "packages/testing/test/terraform-policy.isolation.test.ts",
    "packages/logger/test/sentry-init.test.ts",
    "apps/api/test/metrics.test.ts",
]

EMF = ROOT / "packages/logger/src/emf.ts"
SENTRY = ROOT / "packages/logger/src/sentry-init.ts"
TRACE = ROOT / "packages/queue/src/trace.ts"
MIDDLEWARE = ROOT / "apps/api/src/middleware/metrics.ts"
ROUTE = ROOT / "apps/api/src/routes/metrics.ts"
OBSERVABILITY_TF = ROOT / "infra/terraform/modules/observability/main.tf"
PRODUCTION_TF = ROOT / "infra/terraform/environments/production/main.tf"

# Source edits need a rebuild of the workspace package before the test sees
# them. Anything under packages/*/src is marked so.
BUILD_AFTER = {EMF, SENTRY, TRACE}

# (file, description, old, new)
MUTATIONS = [
    # --- the alarms and the code agree ----------------------------------
    (
        EMF,
        "a metric is renamed in code but not in the alarm",
        "  queueDepth: 'QueueDepth',",
        "  queueDepth: 'QueueDepthV2',",
    ),
    (
        OBSERVABILITY_TF,
        "an alarm is renamed but the code is not",
        'metric_name = "DeadLetters"',
        'metric_name = "DeadLetterCount"',
    ),
    (
        EMF,
        "a metric is emitted that no alarm watches",
        "  workspaceComplaintRate: 'WorkspaceComplaintRate',",
        "  workspaceComplaintRate: 'WorkspaceComplaintRate',\n  orphan: 'NobodyWatchesThis',",
    ),
    # --- EMF shape ------------------------------------------------------
    (
        EMF,
        "dimensions are in the body but not in the directive",
        "          Dimensions: [names],",
        "          Dimensions: [[]],",
    ),
    (
        EMF,
        "metric values are nested inside _aws instead of at the top level",
        "    ...dimensions,\n    ...values,",
        "    ...dimensions,",
    ),
    (
        EMF,
        "an emit with no metrics is accepted",
        "    throw new Error('emf: no metrics to emit');",
        "    return {};",
    ),
    (
        EMF,
        "more dimensions than CloudWatch accepts are allowed through",
        "  if (names.length > MAX_DIMENSIONS) {",
        "  if (names.length > MAX_DIMENSIONS * 100) {",
    ),
    (
        EMF,
        "the dimension limit is off by one and rejects a legal emit",
        "  if (names.length > MAX_DIMENSIONS) {",
        "  if (names.length >= MAX_DIMENSIONS) {",
    ),
    (
        EMF,
        "the namespace stops matching the Terraform",
        "  return `Relayd/${environment}`;",
        "  return `relayd-${environment}`;",
    ),
    # --- Sentry ---------------------------------------------------------
    (
        SENTRY,
        "the scrubber is no longer attached",
        "    beforeSend,\n",
        "",
    ),
    (
        SENTRY,
        "breadcrumbs bypass the scrubber",
        "    beforeBreadcrumb: (breadcrumb) => beforeSend(breadcrumb),",
        "    beforeBreadcrumb: (breadcrumb) => breadcrumb,",
    ),
    (
        SENTRY,
        "PII is sent by default",
        "    sendDefaultPii: false,",
        "    sendDefaultPii: true,",
    ),
    (
        SENTRY,
        "billing operations are sampled at the ordinary rate",
        "    if (shouldAlwaysSample(context.name)) return 1;",
        "    if (false) return 1;",
    ),
    (
        SENTRY,
        "an upstream sampling decision is ignored",
        "    if (context.parentSampled !== undefined) return context.parentSampled ? 1 : 0;",
        "",
    ),
    (
        SENTRY,
        "the sample rate is quietly raised to 100%",
        "export const DEFAULT_TRACES_SAMPLE_RATE = 0.05;",
        "export const DEFAULT_TRACES_SAMPLE_RATE = 1;",
    ),
    (
        SENTRY,
        "an empty DSN is treated as configured",
        "  if (options.dsn === undefined || options.dsn === '') return false;",
        "  if (options.dsn === undefined) return false;",
    ),
    (
        SENTRY,
        "shutdown no longer flushes buffered events",
        "  return Sentry.flush(timeoutMs);",
        "  return timeoutMs > 0;",
    ),
    # --- trace across the queue -----------------------------------------
    (
        TRACE,
        "the trace is not attached to the job payload",
        "  return { ...payload, [TRACE_FIELD]: context };",
        "  return payload;",
    ),
    (
        TRACE,
        "the consumer starts a fresh trace instead of resuming the producer's",
        "    carried === undefined ? { ...newIds(), jobId } : { ...carried, jobId };",
        "    carried === undefined ? { ...newIds(), jobId } : { ...newIds(), jobId };",
    ),
    (
        TRACE,
        "the consumer inherits the producer's job id",
        "carried === undefined ? { ...newIds(), jobId } : { ...carried, jobId };",
        "carried === undefined ? { ...newIds(), jobId } : { jobId, ...carried };",
    ),
    (
        TRACE,
        "an untraced job runs with no ids at all",
        "  return runWithTrace(context, fn);",
        "  return carried === undefined ? fn() : runWithTrace(context, fn);",
    ),
    (
        TRACE,
        "_trace is left on the payload the consumer validates",
        "  const { [TRACE_FIELD]: _ignored, ...rest } = payload;\n  return rest as unknown as T;",
        "  return payload as unknown as T;",
    ),
    # --- the route label ------------------------------------------------
    (
        MIDDLEWARE,
        "the route label is built from the path, so series are unbounded",
        "  if (route?.path === undefined) return UNMATCHED_ROUTE;\n"
        "  return `${request.baseUrl}${route.path}` || '/';",
        "  return request.path;",
    ),
    (
        MIDDLEWARE,
        "the mount path is dropped, so two routers share a series",
        "  return `${request.baseUrl}${route.path}` || '/';",
        "  return route.path || '/';",
    ),
    (
        MIDDLEWARE,
        "every status collapses to one label, so the 5xx alarm has no ratio",
        "  if (status >= 500) return '5xx';",
        "  if (status >= 5000) return '5xx';",
    ),
    (
        MIDDLEWARE,
        "a client that hangs up mid-response is never counted",
        "    response.once('close', record);",
        "",
    ),
    # --- the metrics endpoint -------------------------------------------
    (
        ROUTE,
        "the metrics response becomes cacheable",
        "    response.setHeader('Cache-Control', 'no-store');",
        "    response.setHeader('Cache-Control', 'public, max-age=60');",
    ),
    (
        PRODUCTION_TF,
        "the load balancer starts routing /metrics",
        'path_patterns     = ["/api/*"]',
        'path_patterns     = ["/api/*", "/metrics"]',
    ),
    (
        PRODUCTION_TF,
        "a catch-all rule exposes /metrics by accident",
        'path_patterns     = ["/o/*", "/c/*", "/u/*", "/ingest/*"]',
        'path_patterns     = ["/o/*", "/c/*", "/u/*", "/ingest/*", "/m*"]',
    ),
]


def build() -> bool:
    result = subprocess.run(
        ["pnpm", "turbo", "run", "build", "--filter=@relayd/logger", "--filter=@relayd/queue"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
        timeout=900,
    )
    return result.returncode == 0


def run_suites() -> bool:
    """True when every suite passes."""
    result = subprocess.run(
        ["node", "node_modules/vitest/vitest.mjs", "run", *SUITES, "--reporter=basic"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=900,
    )
    return result.returncode == 0


def main() -> int:
    if not build():
        print("BASELINE BUILD FAILS")
        return 1

    if not run_suites():
        print("BASELINE FAILS - fix the suites before running mutations")
        return 1

    caught = 0
    missed = []

    for path, description, old, new in MUTATIONS:
        original = path.read_text(encoding="utf-8")

        if old not in original:
            print(f"ANCHOR  {description}")
            print(f"        not found in {path.name}")
            missed.append(description + " (anchor)")
            continue

        if original.count(old) != 1:
            print(f"ANCHOR  {description}")
            print(f"        matches {original.count(old)} times in {path.name}")
            missed.append(description + " (ambiguous anchor)")
            continue

        path.write_text(original.replace(old, new), encoding="utf-8", newline="\n")

        try:
            if path in BUILD_AFTER and not build():
                # A mutation that does not compile is caught, but say so
                # rather than claiming the assertions did it.
                print(f"CAUGHT  {description} (does not compile)")
                caught += 1
                continue

            passed = run_suites()
        finally:
            path.write_text(original, encoding="utf-8", newline="\n")
            if path in BUILD_AFTER:
                build()

        if passed:
            print(f"MISSED  {description}")
            missed.append(description)
        else:
            print(f"CAUGHT  {description}")
            caught += 1

    print()
    print(f"{caught}/{len(MUTATIONS)} caught")

    if missed:
        print("MISSED:")
        for description in missed:
            print(f"  - {description}")
        return 1

    if not run_suites():
        print("RESTORE FAILED - the tree did not come back clean")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
