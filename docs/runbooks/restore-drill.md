Written for: whoever is on call, reading this at 3am under pressure.

# The timed restore drill

**Quarterly. Mandatory. Timed with a stopwatch.** docs/10: "An untested
backup is not a backup."

Target: a usable database, verified, inside **one hour** from the moment the
clock starts. That is the RTO the whole design is built around, and the only
way to know whether it holds is to do it with a stopwatch and write the
number down.

Run it against **staging**. Staging is a smaller production built from the
same Terraform modules, which is the reason it is built that way. Running the
drill against production would be a deliberate outage.

**Never restore over production.** Every restore here creates a *new*
instance, and the script has no flag that would change that. When you are
following this file during a real incident rather than a drill, that is the
rule that matters most: restoring in place destroys the evidence of what went
wrong and cannot be undone.

---

## Before you start

```bash
export AWS_PROFILE=relayd-staging
export AWS_REGION=eu-west-1          # or whatever the environment uses
export ENVIRONMENT=staging
```

Have a second terminal open on the CloudWatch console. Some of the waits are
long and you want to see progress rather than wonder.

**Start the stopwatch now.** Not after the first command succeeds. The clock
includes reading this file.

---

## 1. Record where you are restoring to

```bash
bash scripts/dr/restore-drill.sh plan
```

It prints the source instance, the earliest restorable time, the latest
restorable time, and the target it will create. Read them. The two things
that go wrong here are restoring the wrong instance and picking a timestamp
outside the window, and both are obvious in this output and invisible later.

Write the target time you choose in the table at the bottom of this file.

---

## 2. Restore to a new instance

```bash
bash scripts/dr/restore-drill.sh restore '2026-09-19T11:00:00Z'
```

This creates `relayd-staging-drill-<date>`. It does **not** touch the
running instance, and there is no flag in the script that would let it.

Typical time: 15–25 minutes for a small instance, longer with more data. The
script waits and prints progress. This is the long pole; everything after it
is minutes.

While you wait, do step 3 — it needs no database.

---

## 3. Confirm the backup configuration is what you think

```bash
bash scripts/dr/restore-drill.sh verify-config
```

Checks, on the *live* instance:

- automated backups on, with the retention docs/10 asks for (7 staging, 30 production)
- PITR window actually present, and how far back it reaches
- storage encrypted with our KMS key
- deletion protection on in production
- a cross-region copy exists and is recent

A drill that restores successfully from a backup policy that was quietly
weakened last month proves less than it appears to. This is the step that
catches that, and it is the one most often skipped because the restore is
the interesting part.

---

## 4. Verify the restored data

```bash
bash scripts/dr/restore-drill.sh verify-data
```

This is the step that makes the drill mean something. A restored instance
that accepts a connection is not a restored database.

It checks:

- every migration in `_relayd_migrations` is present, and the checksums match
- RLS is enabled on every tenant table, and the policies exist
- `relayd_app` and `relayd_global` exist with the right attributes
- row counts on the core tables are within a sane band of the live instance
- a scoped query as `relayd_app` returns one workspace's rows and not another's
- `campaign_counters` agrees with `campaign_recipients` for a sample of campaigns

The RLS check is the one that matters most and is easiest to skip. A restore
brings tables back; whether it brought the *policies* back is a different
question, and a database that returns everybody's rows to everybody is worse
than one that is down.

---

## 5. Tear down

```bash
bash scripts/dr/restore-drill.sh cleanup
```

**Stop the stopwatch before this step**, not after. Cleanup is not part of
recovery — in a real incident you would be promoting this instance, not
deleting it.

The script refuses to delete anything whose identifier does not contain
`-drill-`. There is no override.

---

## 6. Write down the numbers

Fill this in and commit it. The trend across quarters is the point — a drill
that took 35 minutes and now takes 55 is telling you something a single
passing run does not.

| Field | Value |
| --- | --- |
| Date | |
| Run by | |
| Environment | |
| Source instance | |
| Restore point chosen | |
| Clock start | |
| Restore complete | |
| Verification complete | |
| **Total (target: < 60 min)** | |
| Data verification | pass / fail |
| Config verification | pass / fail |
| Anything that surprised you | |

### Drill log

*(No drill has been run. This repository has never been deployed; the
Terraform in `infra/terraform` has not been applied to an AWS account. The
first entry belongs here.)*

| Date | Env | Total | Result | Notes |
| --- | --- | --- | --- | --- |
| | | | | |

---

## If the drill fails

A failed drill is the drill working. Do not retry until it passes and then
record the passing run — record the failure, then fix the cause.

| Symptom | Where to look |
| --- | --- |
| No restorable time, or a window shorter than expected | `backup_retention_period` on the instance. The Terraform validates `>= 1`, but a console change bypasses Terraform. |
| Restore fails with a KMS error | The drill instance needs the same key. Cross-account or cross-region restores need the key shared. |
| Restore succeeds, migrations missing | The restore point predates the last deploy. Expected if you chose an old timestamp; alarming if you did not. |
| RLS policies absent | Serious. Policies are created by migrations, so this means the migration record and the schema disagree. Stop and investigate before trusting any backup. |
| Row counts far below live | Check the restore point against the deploy timeline before assuming data loss. |
| Total time over 60 minutes | The RTO does not hold. This is a finding, not a slow day — record it and raise it. |

---

## Why a restore and not a snapshot check

A snapshot that exists is not a backup. The things that actually go wrong —
a KMS key policy that no longer permits decrypt, a parameter group that no
longer exists, a retention window quietly reduced, an engine version that
cannot be restored to — are all invisible until somebody tries to restore,
and all of them produce a perfectly healthy-looking snapshot list.
