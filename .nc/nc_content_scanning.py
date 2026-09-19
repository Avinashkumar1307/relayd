"""Negative controls for the phishing lint, link reputation and block list.

Covers:
  packages/campaigns/test/phishing.test.ts
  packages/campaigns/test/link-reputation.test.ts
  packages/campaigns/test/launch.test.ts
  packages/db/test/block-list.test.ts

docs/06 puts all three in "the section that keeps the business alive". The
mutations split into two kinds, and both matter:

  The control stops catching what it is for.
  The control starts catching everybody, which is how it gets switched off.

Run: python3 .nc/nc_content_scanning.py
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SUITES = [
    "packages/campaigns/test/phishing.test.ts",
    "packages/campaigns/test/link-reputation.test.ts",
    "packages/campaigns/test/launch.test.ts",
    "packages/db/test/block-list.test.ts",
]

PHISH = ROOT / "packages/campaigns/src/abuse/phishing.ts"
REP = ROOT / "packages/campaigns/src/abuse/link-reputation.ts"
LAUNCH = ROOT / "packages/campaigns/src/engine/launch.ts"
BLOCK = ROOT / "packages/db/src/repositories/global/block-list.ts"
MIGRATION = ROOT / "packages/db/migrations/0018_global_block_list.sql"

BUILD_AFTER = {PHISH, REP, LAUNCH, BLOCK}

# (file, description, old, new)
MUTATIONS = [
    # --- the lint catches what it should --------------------------------
    (PHISH, "an executable attachment is allowed through",
     "    if (EXECUTABLE_EXTENSIONS.includes(extension)) {",
     "    if (extension === 'definitely-not-a-real-extension') {"),
    (PHISH, "only the first extension is checked, so invoice.pdf.exe passes",
     "    const extension = attachment.filename.split('.').pop()?.toLowerCase() ?? '';",
     "    const extension = attachment.filename.split('.')[1]?.toLowerCase() ?? '';"),
    (PHISH, "a raw IP link stops being noticed",
     "    if (IPV4.test(host)) {", "    if (IPV4.test(host) && host === 'never') {"),
    (PHISH, "brand impersonation stops blocking",
     "  brand_impersonation: 100,", "  brand_impersonation: 10,"),
    (PHISH, "the block threshold is raised so nothing ever blocks",
     "export const BLOCK_SCORE = 100;", "export const BLOCK_SCORE = 10_000;"),
    (PHISH, "credential language is no longer noticed",
     "  const credential = findCredentialLanguage(`${input.subject}\\n${stripTags(input.html)}`);",
     "  const credential = findCredentialLanguage(stripTags(input.html).slice(0, 0));"),
    (PHISH, "a shortener stops being flagged",
     "    if (SHORTENER_DOMAINS.includes(baseDomain(host))) {", "    if (false) {"),
    (PHISH, "mismatched link text stops being flagged",
     "    if (linkTextMismatch(link)) {", "    if (false) {"),
    (PHISH, "link text is compared with tags still in it",
     "    const text = (match[4] ?? '').replace(/<[^>]*>/gu, '').replace(/\\s+/gu, ' ').trim();",
     "    const text = (match[4] ?? '').replace(/\\s+/gu, ' ').trim();"),
    # --- the lint does not catch everybody -------------------------------
    (PHISH, "credential language alone blocks, teaching everyone to reword",
     "  credential_language: 25,", "  credential_language: 100,"),
    (PHISH, "a shortener alone blocks",
     "  url_shortener: 20,", "  url_shortener: 100,"),
    (PHISH, "the real brand is flagged for impersonating itself",
     "    if (fromDomain.startsWith(`${brand}.`) || fromDomain === `${brand}.com`) break;", ""),
    (PHISH, "a brand name inside a longer word is flagged",
     "  const fromNameWords = input.fromName.toLowerCase().split(/[^a-z0-9]+/u).filter((w) => w !== '');",
     "  const fromNameWords = [input.fromName.toLowerCase()];"),
    (PHISH, "\"click here\" counts as a mismatched link",
     "  const claimed = /^(?:https?:\\/\\/)?((?:[a-z0-9-]+\\.)+[a-z]{2,})(?:[/?#]|$)/iu.exec(text);\n"
     "  if (claimed === null) return false;",
     "  const claimed = /^(.*)$/iu.exec(text);\n"
     "  if (claimed === null) return false;"),
    (PHISH, "a subdomain counts as a mismatch",
     "  const claimedHost = baseDomain((claimed[1] ?? '').toLowerCase());\n"
     "  const actualHost = baseDomain(hostOf(link.href));",
     "  const claimedHost = (claimed[1] ?? '').toLowerCase();\n"
     "  const actualHost = hostOf(link.href);"),
    (PHISH, "a short brand name near-misses onto everything",
     "    if (brand.length >= 5 && editDistance(name, brand, 1) === 1) return brand;",
     "    if (editDistance(name, brand, 1) === 1) return brand;"),
    (PHISH, "phishing phrases are matched inside stylesheets",
     "    .replace(/<(script|style)\\b[\\s\\S]*?<\\/\\1>/giu, ' ')", ""),
    (PHISH, "the same finding is counted once per occurrence",
     "    if (!findings.some((existing) => existing.code === finding.code)) {",
     "    if (true) {"),
    (PHISH, "severity is no longer derived from the weight",
     "      findings.push({ ...finding, severity: severityOf(finding.code) });",
     "      findings.push({ ...finding, severity: 'warning' });"),
    # --- link reputation --------------------------------------------------
    (REP, "a malicious domain no longer blocks",
     "  const blocked = results.filter((result) => result.verdict === 'malicious');",
     "  const blocked = results.filter(() => false);"),
    (REP, "suspicious blocks too, so the category gets switched off",
     "  const blocked = results.filter((result) => result.verdict === 'malicious');",
     "  const blocked = results.filter((result) => result.verdict !== 'clean');"),
    (REP, "a feed outage blocks every launch",
     "    return {\n      ok: true,\n      checked: 0,\n      unavailable: true,",
     "    return {\n      ok: false as true,\n      checked: 0,\n      unavailable: true,"),
    (REP, "a feed outage is not recorded",
     "      unavailable: true,\n      error: error instanceof Error ? error.message : 'reputation lookup failed',",
     "      unavailable: false as unknown as true,\n      error: '',"),
    (REP, "the lookup has no timeout, so it can hold the launch transaction",
     "    results = await withTimeout(port.lookup(unique), timeoutMs);",
     "    results = await withTimeout(port.lookup(unique), timeoutMs * 100_000);"),
    (REP, "an unknown verdict is cached, hiding a newly-listed domain",
     "        if (result.verdict !== 'unknown') cache.set(result.domain, { at: current, value: result });",
     "        cache.set(result.domain, { at: current, value: result });"),
    (REP, "the cache never expires",
     "        if (hit !== undefined && current - hit.at < ttlMs) fresh.push(hit.value);",
     "        if (hit !== undefined && current - hit.at < ttlMs * 1e9) fresh.push(hit.value);"),
    # --- the launch gate ---------------------------------------------------
    (LAUNCH, "a blocked domain no longer stops the launch",
     "  if (scan.blockedDomains.length > 0) {", "  if (false) {"),
    (LAUNCH, "a blocked lint result no longer stops the launch",
     "  if (scan.blocked) {", "  if (false) {"),
    (LAUNCH, "warnings are discarded instead of recorded",
     "  if (scan.findings.length > 0) {", "  if (false) {"),
    (LAUNCH, "a feed outage is not recorded on the campaign",
     "  if (scan.reputationUnavailable) {", "  if (false) {"),
    (LAUNCH, "the flagged domain is not named in the message",
     "      `This campaign links to ${scan.blockedDomains.join(', ')}, which a security feed has flagged. Remove the link or contact support.`,",
     "      'This campaign links to a flagged domain.',"),
    # --- the block list ----------------------------------------------------
    (BLOCK, "the address hash loses its pepper",
     "  return createHash('sha256').update(pepper).update('\\u0000').update(normalised).digest();",
     "  return createHash('sha256').update(pepper.slice(0, 0)).update(normalised).digest();"),
    (BLOCK, "the pepper and address run together with no separator",
     "  return createHash('sha256').update(pepper).update('\\u0000').update(normalised).digest();",
     "  return createHash('sha256').update(pepper + normalised).digest();"),
    (BLOCK, "addresses stop being normalised, so case defeats the list",
     "  const normalised = address.trim().toLowerCase();",
     "  const normalised = address;"),
    (BLOCK, "a permanent block is dropped because null compares as false",
     "          or(isNull(blockedLinkDomains.expiresAt), gt(blockedLinkDomains.expiresAt, now)),",
     "          or(gt(blockedLinkDomains.expiresAt, now), isNull(blockedLinkDomains.domain)),"),
    (MIGRATION, "the block list gains a workspace_id, defeating the feature",
     "  address_hash bytea PRIMARY KEY,",
     "  workspace_id uuid NOT NULL,\n  address_hash bytea PRIMARY KEY,"),
    (MIGRATION, "the missing RLS is left for a reader to guess about",
     "-- Deliberately no RLS.", "-- (no policy here)"),
]


def build() -> bool:
    result = subprocess.run(
        ["pnpm", "turbo", "run", "build", "--filter=@relayd/campaigns", "--filter=@relayd/db"],
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
