"""Negative controls for packages/testing/test/deploy-pipeline.test.ts.

Each mutation is an edit somebody could plausibly make and defend in a
review. The test suite has to fail for every one of them, or it is not
holding the property it claims to.

Run: python3 .nc/nc_deploy_pipeline.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "packages/testing/test/deploy-pipeline.test.ts"

DEPLOY = ROOT / ".github/workflows/deploy.yml"
ROLLBACK = ROOT / ".github/workflows/rollback.yml"
CI = ROOT / ".github/workflows/ci.yml"
REGISTER = ROOT / "scripts/deploy/register-revision.sh"
MIGRATE = ROOT / "scripts/deploy/migrate.sh"
SMOKE = ROOT / "scripts/deploy/smoke.sh"
PREVIOUS = ROOT / "scripts/deploy/previous-digest.sh"

# (file, description, old, new)
MUTATIONS = [
    # --- build once -----------------------------------------------------
    (
        DEPLOY,
        "production rebuilds the image instead of promoting the digest",
        "      - name: Migrate\n        run: >-\n          bash scripts/deploy/migrate.sh\n          relayd-production",
        "      - uses: docker/setup-buildx-action@v3\n"
        "      - name: Rebuild for production\n"
        "        run: docker buildx build -f infra/docker/Dockerfile .\n"
        "      - name: Migrate\n        run: >-\n          bash scripts/deploy/migrate.sh\n          relayd-production",
    ),
    (
        DEPLOY,
        "production deploys a floating tag rather than the built digest",
        "          bash scripts/deploy/deploy-services.sh\n"
        "          relayd-production production '${{ needs.build.outputs.image }}'",
        "          bash scripts/deploy/deploy-services.sh\n"
        "          relayd-production production 'relayd:latest'",
    ),
    (
        REGISTER,
        "a tag is accepted instead of a digest",
        "  *@sha256:*) ;;",
        "  *) ;;",
    ),
    (
        REGISTER,
        "the digest refusal warns but carries on",
        "    exit 2\n    ;;",
        "    ;;",
    ),
    # --- migrations -----------------------------------------------------
    (
        DEPLOY,
        "staging migrates after the service update",
        "      - name: Migrate\n"
        "        run: >-\n"
        "          bash scripts/deploy/migrate.sh\n"
        "          relayd-staging\n"
        "          relayd-staging-migrate\n"
        "          '${{ needs.build.outputs.image }}'\n"
        "          api\n"
        "\n"
        "      - name: Deploy\n"
        "        run: >-\n"
        "          bash scripts/deploy/deploy-services.sh\n"
        "          relayd-staging staging '${{ needs.build.outputs.image }}'\n",
        "      - name: Deploy\n"
        "        run: >-\n"
        "          bash scripts/deploy/deploy-services.sh\n"
        "          relayd-staging staging '${{ needs.build.outputs.image }}'\n"
        "\n"
        "      - name: Migrate\n"
        "        run: >-\n"
        "          bash scripts/deploy/migrate.sh\n"
        "          relayd-staging\n"
        "          relayd-staging-migrate\n"
        "          '${{ needs.build.outputs.image }}'\n"
        "          api\n",
    ),
    (
        DEPLOY,
        "production skips migrations entirely",
        "      - name: Migrate\n"
        "        run: >-\n"
        "          bash scripts/deploy/migrate.sh\n"
        "          relayd-production",
        "      - name: Migrate (skipped)\n"
        "        if: false\n"
        "        run: >-\n"
        "          echo skip\n"
        "          relayd-production",
    ),
    (
        MIGRATE,
        "a failed migration no longer fails the deploy",
        '  exit "$exit_code"',
        '  echo "continuing anyway"',
    ),
    (
        MIGRATE,
        "a task that never ran is treated as a success",
        'if [ -z "$exit_code" ]; then',
        "if false; then",
    ),
    (
        ROLLBACK,
        "rollback re-runs migrations",
        "      - name: Redeploy",
        "      - name: Migrate\n"
        "        run: bash scripts/deploy/migrate.sh a b c d\n"
        "      - name: Redeploy",
    ),
    # --- gating ---------------------------------------------------------
    (
        DEPLOY,
        "production no longer waits for staging",
        "    needs: [build, staging]",
        "    needs: [build]",
    ),
    (
        DEPLOY,
        "the production approval environment is dropped",
        "    environment:\n      name: production\n      url: https://${{ vars.PRODUCTION_HOSTNAME }}",
        "    environment:\n      name: prod-nogate\n      url: https://${{ vars.PRODUCTION_HOSTNAME }}",
    ),
    (
        DEPLOY,
        "staging is deployed but never smoke-tested",
        '      - name: Smoke\n        run: bash scripts/deploy/smoke.sh "https://${{ vars.STAGING_HOSTNAME }}"',
        "      - name: Smoke\n        run: echo skipped",
    ),
    (
        DEPLOY,
        "production smoke-tests before deploying, so it tests the old image",
        "      - name: Deploy\n"
        "        run: >-\n"
        "          bash scripts/deploy/deploy-services.sh\n"
        "          relayd-production production '${{ needs.build.outputs.image }}'\n"
        "\n"
        '      - name: Smoke\n        run: bash scripts/deploy/smoke.sh "https://${{ vars.PRODUCTION_HOSTNAME }}"\n',
        '      - name: Smoke\n        run: bash scripts/deploy/smoke.sh "https://${{ vars.PRODUCTION_HOSTNAME }}"\n'
        "\n"
        "      - name: Deploy\n"
        "        run: >-\n"
        "          bash scripts/deploy/deploy-services.sh\n"
        "          relayd-production production '${{ needs.build.outputs.image }}'\n",
    ),
    (
        SMOKE,
        "a smoke test starts writing data",
        'CURL=(curl -sS --max-time 15)',
        'CURL=(curl -sS --max-time 15 -X POST --data "{}")',
    ),
    # --- rollback -------------------------------------------------------
    (
        ROLLBACK,
        "rollback demands a digest instead of resolving one",
        "            image=$(bash scripts/deploy/previous-digest.sh '${{ inputs.environment }}')",
        '            echo "pass image_digest" >&2; exit 1',
    ),
    (
        PREVIOUS,
        "rollback returns the image already running",
        '  if [ "$candidate" != "$current" ]; then',
        "  if true; then",
    ),
    (
        PREVIOUS,
        "rollback accepts a tag",
        "      *@sha256:*)",
        "      *)",
    ),
    # --- concurrency ----------------------------------------------------
    (
        DEPLOY,
        "two deploys may run at once",
        "concurrency:\n  group: deploy\n  cancel-in-progress: false",
        "concurrency:\n  group: deploy-${{ github.sha }}\n  cancel-in-progress: false",
    ),
    (
        DEPLOY,
        "a deploy in flight is cancelled by the next push",
        "  cancel-in-progress: false",
        "  cancel-in-progress: true",
    ),
    (
        ROLLBACK,
        "a rollback may race a deploy",
        "concurrency:\n  group: deploy",
        "concurrency:\n  group: rollback",
    ),
    # --- credentials ----------------------------------------------------
    (
        DEPLOY,
        "OIDC is dropped, so the pipeline needs a static key",
        "  id-token: write",
        "  id-token: none",
    ),
    (
        DEPLOY,
        "production is deployed with the staging role",
        "          role-to-assume: ${{ vars.AWS_PRODUCTION_DEPLOY_ROLE_ARN }}",
        "          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}",
    ),
    # --- CI -------------------------------------------------------------
    (
        CI,
        "the billing suite is allowed to skip silently in CI",
        "      RELAYD_REQUIRE_BILLING_TESTS: '1'",
        "      RELAYD_REQUIRE_BILLING_TESTS: ''",
    ),
    (
        CI,
        "terraform fmt stops being checked",
        "        run: terraform fmt -check -recursive infra/terraform",
        "        run: terraform fmt -recursive infra/terraform",
    ),
]


def run_suite() -> bool:
    """True when the suite passes."""
    result = subprocess.run(
        [
            "node",
            "node_modules/vitest/vitest.mjs",
            "run",
            TEST,
            "--reporter=basic",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,
    )
    return result.returncode == 0


def main() -> int:
    if not run_suite():
        print("BASELINE FAILS - fix the suite before running mutations")
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
            passed = run_suite()
        finally:
            path.write_text(original, encoding="utf-8", newline="\n")

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

    if not run_suite():
        print("RESTORE FAILED - the tree did not come back clean")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
