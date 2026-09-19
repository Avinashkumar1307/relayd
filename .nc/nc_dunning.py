"""Negative controls for packages/billing/src/dunning/ladder.ts."""

import subprocess, sys, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "packages", "billing", "src", "dunning", "ladder.ts")
TEST = "packages/billing/test/dunning.test.ts"

MUTATIONS = [
    ("a running campaign is killed when restricted",
     "    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: true,\n    apiSend: false,",
     "    scheduledCampaigns: 'hold',\n    runningCampaigns: 'cancel' as 'complete',\n    apiWrites: true,\n    apiSend: false,"),

    ("a running campaign is killed when suspended",
     "    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: false,\n    apiSend: false,\n    outboundWebhooks: false,\n    analyticsWrites: false,\n    exportOffered: false,",
     "    scheduledCampaigns: 'hold',\n    runningCampaigns: 'cancel' as 'complete',\n    apiWrites: false,\n    apiSend: false,\n    outboundWebhooks: false,\n    analyticsWrites: false,\n    exportOffered: false,"),

    ("scheduled campaigns held while merely past due",
     "    launchCampaign: true,\n    scheduledCampaigns: 'run',\n    runningCampaigns: 'complete',\n    apiWrites: true,\n    apiSend: true,\n    outboundWebhooks: true,\n    analyticsWrites: true,\n    exportOffered: false,\n  },\n  restricted: {",
     "    launchCampaign: true,\n    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: true,\n    apiSend: true,\n    outboundWebhooks: true,\n    analyticsWrites: true,\n    exportOffered: false,\n  },\n  restricted: {"),

    ("scheduled campaigns still run when restricted",
     "    writeContacts: false,\n    launchCampaign: false,\n    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: true,",
     "    writeContacts: false,\n    launchCampaign: false,\n    scheduledCampaigns: 'run',\n    runningCampaigns: 'complete',\n    apiWrites: true,"),

    ("launching still allowed when restricted",
     "    writeContacts: false,\n    launchCampaign: false,\n    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: true,",
     "    writeContacts: false,\n    launchCampaign: true,\n    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: true,"),

    ("past due already blocks launching",
     "    writeContacts: true,\n    launchCampaign: true,\n    scheduledCampaigns: 'run',\n    runningCampaigns: 'complete',\n    apiWrites: true,\n    apiSend: true,\n    outboundWebhooks: true,\n    analyticsWrites: true,\n    exportOffered: false,\n  },\n  restricted: {",
     "    writeContacts: true,\n    launchCampaign: false,\n    scheduledCampaigns: 'run',\n    runningCampaigns: 'complete',\n    apiWrites: true,\n    apiSend: true,\n    outboundWebhooks: true,\n    analyticsWrites: true,\n    exportOffered: false,\n  },\n  restricted: {"),

    ("restriction kills API writes too",
     "    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: true,\n    apiSend: false,\n    outboundWebhooks: true,",
     "    scheduledCampaigns: 'hold',\n    runningCampaigns: 'complete',\n    apiWrites: false,\n    apiSend: false,\n    outboundWebhooks: true,"),

    ("suspension keeps webhooks running",
     "    apiWrites: false,\n    apiSend: false,\n    outboundWebhooks: false,\n    analyticsWrites: false,\n    exportOffered: false,\n  },\n  export_window: {",
     "    apiWrites: false,\n    apiSend: false,\n    outboundWebhooks: true,\n    analyticsWrites: false,\n    exportOffered: false,\n  },\n  export_window: {"),

    ("login revoked when suspended",
     "  suspended: {\n    // Day 31–90: billing pages only. Nothing is deleted, nothing is used.\n    login: true,",
     "  suspended: {\n    // Day 31–90: billing pages only. Nothing is deleted, nothing is used.\n    login: false,"),

    ("the export is offered at suspension",
     "    analyticsWrites: false,\n    exportOffered: false,\n  },\n  export_window: {",
     "    analyticsWrites: false,\n    exportOffered: true,\n  },\n  export_window: {"),

    ("grace period shortened",
     "export const GRACE_DAYS = 14;",
     "export const GRACE_DAYS = 7;"),

    ("suspension brought forward",
     "export const SUSPEND_DAY = 30;",
     "export const SUSPEND_DAY = 20;"),

    ("export window brought forward",
     "export const EXPORT_DAY = 90;",
     "export const EXPORT_DAY = 60;"),

    ("deletion brought forward",
     "export const DELETE_DAY = 120;",
     "export const DELETE_DAY = 100;"),

    ("restriction boundary off by one",
     "  if (day >= GRACE_DAYS) return 'restricted';",
     "  if (day > GRACE_DAYS) return 'restricted';"),

    ("suspension boundary off by one",
     "  if (day >= SUSPEND_DAY) return 'suspended';",
     "  if (day > SUSPEND_DAY) return 'suspended';"),

    ("a paid subscription stays in dunning",
     "  if (input.status === 'active' || input.status === 'trialing') return 'current';",
     "  if (false) return 'current';"),

    ("a trial counts as a failure",
     "  if (input.status === 'active' || input.status === 'trialing') return 'current';",
     "  if (input.status === 'active') return 'current';"),

    ("a cleared clock is not treated as current",
     "  if (input.status === 'active' || input.status === 'trialing') return 'current';",
     "  if ((input.status === 'active' || input.status === 'trialing') && false) return 'current';"),

    ("a backwards clock skips ahead",
     "  if (!Number.isFinite(ms) || ms < 0) return 0;",
     "  if (!Number.isFinite(ms)) return 0;"),

    ("the provider status alone drives the ladder",
     "  const day = daysBetween(input.firstFailedAt, input.now);",
     "  const day = input.status === 'unpaid' ? SUSPEND_DAY : daysBetween(input.firstFailedAt, input.now);"),

    ("the final warning before restriction is dropped",
     "export const NOTICE_DAYS: readonly number[] = [0, 3, 7, 13, 14, 30, 60, 85];",
     "export const NOTICE_DAYS: readonly number[] = [0, 3, 7, 14, 30, 60, 85];"),

    ("the final warning before deletion is dropped",
     "export const NOTICE_DAYS: readonly number[] = [0, 3, 7, 13, 14, 30, 60, 85];",
     "export const NOTICE_DAYS: readonly number[] = [0, 3, 7, 13, 14, 30, 60];"),

    ("only today's notice is sent",
     "  return NOTICE_DAYS.filter((noticeDay) => noticeDay <= input.day && !sent.has(noticeDay));",
     "  return NOTICE_DAYS.filter((noticeDay) => noticeDay === input.day && !sent.has(noticeDay));"),

    ("notices are resent",
     "  return NOTICE_DAYS.filter((noticeDay) => noticeDay <= input.day && !sent.has(noticeDay));",
     "  return NOTICE_DAYS.filter((noticeDay) => noticeDay <= input.day);"),

    ("notices are sent early",
     "  return NOTICE_DAYS.filter((noticeDay) => noticeDay <= input.day && !sent.has(noticeDay));",
     "  return NOTICE_DAYS.filter((noticeDay) => !sent.has(noticeDay));"),

    ("deletion skips the stage check",
     "  if (input.stage !== 'deletable') return false;",
     "  if (false) return false;"),

    ("deletion skips the notice count",
     "  if (input.noticesSent < REQUIRED_DELETION_NOTICES) return false;",
     "  if (false) return false;"),

    ("deletion skips the export window",
     "  return input.exportOfferedAt !== null;",
     "  return true;"),

    ("the stage changes before the notice goes out",
     "  for (const noticeDay of dueNotices({ day, sentDays: workspace.noticesSentDays })) {\n    await port.sendNotice({ workspaceId: workspace.workspaceId, day: noticeDay, stage });\n    outcome.noticesSent.push(noticeDay);\n  }\n\n  if (stage !== workspace.stage) {",
     "  if (stage !== workspace.stage) {\n    await port.setStage({ workspaceId: workspace.workspaceId, subscriptionId: workspace.subscriptionId, stage });\n  }\n  for (const noticeDay of dueNotices({ day, sentDays: workspace.noticesSentDays })) {\n    await port.sendNotice({ workspaceId: workspace.workspaceId, day: noticeDay, stage });\n    outcome.noticesSent.push(noticeDay);\n  }\n\n  if (stage !== workspace.stage) {"),

    ("an unchanged stage is rewritten",
     "  if (stage !== workspace.stage) {\n    outcome.stageChanged = await port.setStage({",
     "  if (true) {\n    outcome.stageChanged = await port.setStage({"),

    ("campaigns are never held",
     "  if (capabilitiesFor(stage).scheduledCampaigns === 'hold') {",
     "  if (false) {"),

    ("campaigns are always held",
     "  if (capabilitiesFor(stage).scheduledCampaigns === 'hold') {",
     "  if (true) {"),

    ("payment does not release held campaigns",
     "    outcome.campaignsReleased = await port.releaseHeldCampaigns(workspace.workspaceId);",
     "    outcome.campaignsReleased = 0;"),

    ("a resolved workspace keeps getting notices",
     "  if (stage === 'current') {",
     "  if (false) {"),
]


def run():
    return subprocess.run(
        ["node", os.path.join(ROOT, "node_modules", "vitest", "vitest.mjs"),
         "run", TEST, "--reporter=basic"],
        cwd=ROOT, capture_output=True, text=True, errors="replace", timeout=300,
    )


def main():
    original = open(SRC, encoding="utf-8").read()

    baseline = run()
    if baseline.returncode != 0:
        print("BASELINE FAILS")
        print(baseline.stdout[-3000:].encode("ascii","replace").decode("ascii"))
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
