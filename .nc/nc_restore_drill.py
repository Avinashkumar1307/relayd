"""Negative controls for packages/testing/test/restore-drill.test.ts.

The drill cannot be executed without AWS. What can be proven is that its
refusals hold, and these mutations are the ways somebody removes one:
loosening a pattern, moving a guard after the API call, adding the override
flag that seems reasonable at the time.

Run: python3 .nc/nc_restore_drill.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEST = "packages/testing/test/restore-drill.test.ts"

SCRIPT = ROOT / "scripts/dr/restore-drill.sh"
RUNBOOK = ROOT / "docs/runbooks/restore-drill.md"
DR = ROOT / "docs/runbooks/disaster-recovery.md"

# (file, description, old, new)
MUTATIONS = [
    (
        SCRIPT,
        "cleanup accepts any identifier",
        '    *-drill-*) ;;\n    *) die "refusing to delete',
        '    *) ;;\n    *drill-never-matches*) die "refusing to delete',
    ),
    (
        SCRIPT,
        "cleanup guard is loosened to match the live instance name",
        "    *-drill-*) ;;",
        "    *relayd-*) ;;",
    ),
    (
        SCRIPT,
        "a pre-flight AWS call lands ahead of the cleanup guard",
        "cmd_cleanup() {\n  local target=${1:-$DRILL_ID}",
        'cmd_cleanup() {\n  local target=${1:-$DRILL_ID}\n  instance "$target" >/dev/null || true',
    ),
    (
        SCRIPT,
        "the restore target guard is removed",
        "    *-drill-*|*-recovery*) ;;\n"
        "    *) die \"refusing target '$target': a restore target must contain -drill- or -recovery\" ;;",
        "    *) ;;",
    ),
    (
        SCRIPT,
        "the restore guard moves after the AWS call",
        '  case "$target" in\n'
        "    *-drill-*|*-recovery*) ;;\n"
        "    *) die \"refusing target '$target': a restore target must contain -drill- or -recovery\" ;;\n"
        "  esac\n"
        "\n"
        '  [ "$target" != "$SOURCE" ] || die "refusing to restore onto the source instance"\n'
        "\n"
        "  local source\n"
        "  source=$(instance \"$SOURCE\")\n",
        "  local source\n"
        "  source=$(instance \"$SOURCE\")\n"
        "\n"
        '  case "$target" in\n'
        "    *-drill-*|*-recovery*) ;;\n"
        "    *) die \"refusing target '$target': a restore target must contain -drill- or -recovery\" ;;\n"
        "  esac\n",
    ),
    (
        SCRIPT,
        "a recovery restore is refused, making the DR runbook unfollowable",
        "    *-drill-*|*-recovery*) ;;",
        "    *-drill-*) ;;",
    ),
    (
        SCRIPT,
        "a force flag is added",
        'cmd_cleanup() {\n  local target=${1:-$DRILL_ID}',
        'cmd_cleanup() {\n  local target=${1:-$DRILL_ID}\n  [ "${2:-}" = "--force" ] && return 0',
    ),
    (
        SCRIPT,
        "an in-place modify creeps in",
        "  aws rds restore-db-instance-to-point-in-time \\",
        "  aws rds modify-db-instance --apply-immediately \\",
    ),
    (
        SCRIPT,
        "the usage exit code becomes success, so a typo looks fine",
        "    echo \"usage: restore-drill.sh {plan|restore <iso-8601-utc>|verify-config|verify-data|cleanup}\" >&2\n    exit 2",
        "    echo \"usage: restore-drill.sh {plan|restore <iso-8601-utc>|verify-config|verify-data|cleanup}\" >&2\n    exit 0",
    ),
    (
        RUNBOOK,
        "the drill log implies a drill was run",
        "*(No drill has been run.",
        "*(Drill passed last quarter.",
    ),
    (
        RUNBOOK,
        "the RTO target is dropped from the runbook",
        "| **Total (target: < 60 min)** | |",
        "| **Total** | |",
    ),
    (
        DR,
        "the never-restore-over-production rule is softened away",
        "**Do not restore over production.** Read that again at 3am.",
        "Be careful with the live instance.",
    ),
]


def run_suite() -> bool:
    result = subprocess.run(
        ["node", "node_modules/vitest/vitest.mjs", "run", TEST, "--reporter=basic"],
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
