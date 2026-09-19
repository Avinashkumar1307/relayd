"""Negative controls for consent attestation (BUILD-PLAN Phase 11).

Covers:
  packages/campaigns/test/consent.test.ts
  packages/campaigns/test/launch.test.ts
  packages/testing/test/consent-sources.test.ts
  apps/api/test/campaigns.test.ts
  apps/api/test/audience.test.ts
  apps/api/test/api-key-scope.isolation.test.ts
  apps/web/test/campaign-pages.test.tsx

docs/02 says what the record is for: "This is what lets you defend a
workspace when a provider or a regulator asks, and it is what lets you
suspend a workspace that lied."

Every mutation below is a way the record stops being able to do that while
the tick box still appears on the screen.

Run: python3 .nc/nc_consent.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = [
    "packages/campaigns/test/consent.test.ts",
    "packages/campaigns/test/launch.test.ts",
    "packages/testing/test/consent-sources.test.ts",
    "apps/api/test/campaigns.test.ts",
    "apps/api/test/audience.test.ts",
    "apps/api/test/api-key-scope.isolation.test.ts",
    "apps/web/test/campaign-pages.test.tsx",
]

CONSENT = ROOT / "packages/campaigns/src/abuse/consent.ts"
LAUNCH = ROOT / "packages/campaigns/src/engine/launch.ts"
MIGRATION = ROOT / "packages/db/migrations/0016_consent_attestations.sql"
VALIDATION = ROOT / "packages/validation/src/campaigns.ts"
CAMPAIGN_SVC = ROOT / "apps/api/src/services/campaigns.ts"
AUDIENCE_SVC = ROOT / "apps/api/src/services/audience.ts"
ROUTES = ROOT / "apps/api/src/routes/campaigns.ts"
WEB = ROOT / "apps/web/src/components/consent.tsx"
WEB_PAGE = ROOT / "apps/web/src/routes/campaigns/campaigns.tsx"

BUILD_AFTER = {CONSENT, LAUNCH, VALIDATION}

# (file, description, old, new)
MUTATIONS = [
    # --- the fingerprint binds the claim to an audience -----------------
    (CONSENT, "the fingerprint ignores the audience entirely",
     "  return createHash('sha256').update(canonicalise(audience)).digest('hex').slice(0, 32);",
     "  return createHash('sha256').update(canonicalise(audience)).digest('hex').slice(0, 0);"),
    (CONSENT, "the fingerprint is not compared, so any audience is authorised",
     "  return attestation.audienceFingerprint === audienceFingerprint(audience)\n"
     "    ? { ok: true }\n"
     "    : { ok: false, reason: 'audience_changed' };",
     "  return audienceFingerprint(audience) === 'never'\n"
     "    ? { ok: false, reason: 'audience_changed' }\n"
     "    : { ok: true };"),
    (CONSENT, "an import attestation authorises a campaign launch",
     "  return attestation.audienceFingerprint === audienceFingerprint(audience)",
     "  return attestation.audienceFingerprint === null ||\n"
     "    attestation.audienceFingerprint === audienceFingerprint(audience)"),
    (CONSENT, "arrays stop being sorted, so re-ordering a list breaks the tick",
     "    return `[${[...value].map(canonicalise).sort().join(',')}]`;",
     "    return `[${value.map(canonicalise).join(',')}]`;"),
    (CONSENT, "key order changes the fingerprint",
     "    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));", ""),
    (CONSENT, "a missing attestation is treated as fine",
     "  if (attestation === null) return { ok: false, reason: 'missing' };",
     "  if (attestation === null) return { ok: true };"),
    # --- the declared source -------------------------------------------
    (CONSENT, "any string is accepted as a source",
     "  if (!(CONSENT_SOURCES as readonly string[]).includes(input.source)) {",
     "  if (false) {"),
    (CONSENT, "\"other\" no longer needs explaining",
     "  if (input.source !== 'other') return null;", "  return null;\n  if (input.source !== 'other') return null;"),
    (CONSENT, "whitespace counts as an explanation",
     "  const detail = input.detail?.trim() ?? '';", "  const detail = input.detail ?? '';"),
    (CONSENT, "a two-character explanation is enough",
     "export const MIN_DETAIL_LENGTH = 10;", "export const MIN_DETAIL_LENGTH = 1;"),
    # --- vocabulary parity ---------------------------------------------
    (CONSENT, "the policy gains a source the database will not store",
     "  'other',\n] as const;", "  'other',\n  'trust_me',\n] as const;"),
    (VALIDATION, "the validation schema drifts from the policy",
     "  'imported_from_previous_provider',\n  'other',\n] as const;",
     "  'other',\n] as const;"),
    (MIGRATION, "the database constraint drifts from the policy",
     "                 'in_person',\n", ""),
    # --- the launch gate -----------------------------------------------
    (LAUNCH, "a launch no longer requires consent",
     "  if (!verdict.ok) {", "  if (!verdict.ok && campaign.id === 'never') {"),
    (LAUNCH, "a missing attestation is waved through",
     "  const verdict = attestationAuthorises(attestation, campaign.audience);",
     "  const verdict =\n"
     "    attestation === null\n"
     "      ? ({ ok: true } as const)\n"
     "      : attestationAuthorises(attestation, campaign.audience);"),
    (LAUNCH, "a changed audience reports as merely unconfirmed",
     "    if (verdict.reason === 'audience_changed') {", "    if (false) {"),
    # --- recording it --------------------------------------------------
    (CAMPAIGN_SVC, "the attestation is validated but never written",
     "        await repos.consent.record(scope, {", "        await Promise.resolve({"),
    (CAMPAIGN_SVC, "the fingerprint is not recorded, so it can never be compared",
     "          audienceFingerprint: audienceFingerprint(campaign.audience),",
     "          audienceFingerprint: null,"),
    (CAMPAIGN_SVC, "an invalid source is recorded rather than refused",
     "        if (problem !== null) {", "        if (false) {"),
    (CAMPAIGN_SVC, "the attestation is only written when the launch succeeds",
     "      // Recorded before the engine reads it, in the same transaction, so a",
     "      // MOVED: see below\n      /*"),
    (AUDIENCE_SVC, "an import records no attestation",
     "        await repos.consent.record(scope, {\n"
     "          id: this.options.newId(),\n"
     "          subjectKind: 'import',",
     "        await Promise.resolve({\n"
     "          id: this.options.newId(),\n"
     "          subjectKind: 'import',"),
    (AUDIENCE_SVC, "an import attestation gains an audience fingerprint",
     "          source: input.options.consentSource,\n          detail: input.options.consentDeclaration,",
     "          source: input.options.consentSource,\n          detail: input.options.consentDeclaration,\n          audienceFingerprint: 'anything',"),
    # --- attribution ---------------------------------------------------
    (ROUTES, "an API key may launch, attesting as nobody",
     "    noKeys,\n    validateBody(launchCampaignSchema),",
     "    validateBody(launchCampaignSchema),"),
    # --- the browser ---------------------------------------------------
    (WEB, "the form accepts an unexplained \"other\"",
     "  if (source !== 'other') return true;", "  return true;"),
    (WEB, "the form accepts a source the API will reject",
     "  if (!(CONSENT_SOURCE_VALUES as readonly string[]).includes(source)) return false;", ""),
    (WEB_PAGE, "the first source is pre-selected for everybody",
     "  const [source, setSource] = useState<ConsentSource | ''>('');",
     "  const [source, setSource] = useState<ConsentSource | ''>('signup_form');"),
    (WEB_PAGE, "the declaration is dropped from the request body",
     "      campaignsApi.launch(campaign.id, idempotencyKey, {\n"
     "        source: source as ConsentSource,",
     "      campaignsApi.launch(campaign.id, idempotencyKey, {\n"
     "        source: '' as ConsentSource,"),
]


def build() -> bool:
    result = subprocess.run(
        ["pnpm", "turbo", "run", "build",
         "--filter=@relayd/campaigns", "--filter=@relayd/validation"],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", shell=True, timeout=900,
    )
    return result.returncode == 0


def run_suites() -> bool:
    result = subprocess.run(
        ["node", "node_modules/vitest/vitest.mjs", "run", *SUITES, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=1800,
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
