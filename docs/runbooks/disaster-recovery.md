Written for: whoever is on call, reading this at 3am under pressure.

# Disaster recovery

Three situations, in the order you are likely to meet them. docs/10 sets
**RPO 5 minutes** (PITR transaction logs) and **RTO 1 hour** (full
region-level rebuild).

If you are not sure which situation you are in, you are probably in the third
one. Check the deploy history first — it takes ten seconds and it is the
answer most of the time.

---

## A. A bad deploy

**Most common. Fastest to fix. Check this first.**

Run the **Rollback** workflow in GitHub Actions against the affected
environment. It resolves the previous digest on its own; you do not need to
find one.

Budget: under 3 minutes.

**It does not roll the database back, and that is deliberate.** docs/10:
"Database rollback is almost never a down-migration — it is a forward fix."
Expand-then-contract is what makes rolling the application back safe: the old
code still works against the new schema.

So if the failure is a migration, the rollback will not fix it. Symptoms: the
rollback completes, services go healthy, and the same errors continue. Go to
situation B — you need a PITR clone to see what the data looked like before,
and then a forward fix.

---

## B. Accidental data deletion

A bad `DELETE`, a bad import, a bug that emptied something. The workspace is
still there; some of its data is not.

**Do not restore over production.** Read that again at 3am. The restore
creates a new instance; you extract from it and reinsert into the live one.
Restoring in place destroys the evidence and cannot be undone.

1. **Establish when.** The audit log is the fastest route: every mutating
   action writes an actor, a workspace and a before/after. Find the last
   good moment. Write the timestamp down.

2. **Clone to that point.**

   ```bash
   bash scripts/dr/restore-drill.sh restore '2026-09-19T11:00:00Z' --identifier relayd-production-recovery
   ```

   Pick a point a minute or two *before* the damage, not at it. PITR is
   accurate to about five minutes, and the cost of being slightly early is a
   few minutes of data you reconcile by hand; the cost of being slightly late
   is restoring the deletion.

3. **Extract, do not repoint.** Connect to the clone, pull the rows you need,
   reinsert into production inside a transaction. Scope every query by
   `workspace_id` — the clone has every tenant's data in it, and this is the
   one moment in the system's life when a cross-tenant mistake is easy.

4. **Reconcile the counters.** `campaign_counters` is maintained by triggers
   and will not match reinserted rows. `packages/campaigns` has the
   recompute; run it for every affected campaign. CLAUDE.md section 12 bans
   `COUNT(*)` in a request path, not in a recovery.

5. **Do not touch `usage_records` or `metered`.** The write-once trigger will
   reject it and you should not remove the trigger. If a recipient was
   metered, it stays metered; a customer billed for a send we then lost is a
   refund, handled in Stripe, not a database edit.

6. **Keep the clone for the post-mortem.** Delete it when the write-up is
   done, not before.

---

## C. Full region loss

Budget: ~1 hour. Start the clock and work down this list in order.

1. **Confirm it is the region**, not us. AWS Health Dashboard. If our
   services are the only thing down, this is situation A.

2. **Start the database first.** It is the long pole; everything else can be
   built while it restores.

   ```bash
   aws rds describe-db-snapshots \
     --region "$DR_REGION" \
     --db-instance-identifier relayd-production \
     --snapshot-type automated \
     --query 'reverse(sort_by(DBSnapshots,&SnapshotCreateTime))[0]'
   ```

   The daily cross-region copy is what you restore from. Note the
   `SnapshotCreateTime`: anything written after it is gone, and that number
   is the first thing anybody will ask for.

3. **Apply the Terraform in the DR region.**

   ```bash
   cd infra/terraform/environments/production
   terraform init -backend-config=... -reconfigure
   terraform apply -var region="$DR_REGION" -var image="$LAST_KNOWN_GOOD_DIGEST"
   ```

   The digest is the one from the last successful deploy. `terraform apply`
   refuses a tag — the `image` variable validates for `@sha256:`, which is
   the check that stops somebody reaching for `:latest` under pressure and
   shipping an artifact nobody tested.

4. **Point DNS at the new load balancer.** Route53 is global and survives a
   regional failure. Lower the TTL if you have the chance; you usually do
   not.

5. **Rebuild the queue state, do not restore it.** Redis is a fresh empty
   instance. CLAUDE.md section 9: Redis is transport, Postgres is the system
   of record. Every reconciler exists for this moment — the recipient
   sweeper and the campaign reconciler will re-enqueue what was in flight
   from the states in Postgres.

   Expect duplicate *attempts* and no duplicate *sends*: the durable guard
   is the state transition, not the queue job id.

6. **Do not resend `delivery_uncertain`.** D3, and it applies at scale here.
   Recipients the provider accepted before the region went down are
   unbilled, probably delivered, and will show in the campaign report.
   Resending them is the one action that turns an outage into a
   deliverability incident.

7. **Tell customers the RPO.** The gap between the snapshot time and the
   failure is real data loss — imports, contact edits, campaigns created in
   that window. Say the number.

---

## What to write down while it happens

Not afterwards. Nobody reconstructs these accurately.

| Field | Value |
| --- | --- |
| Detected at | |
| Clock started | |
| Situation (A / B / C) | |
| Restore point used | |
| Service restored at | |
| Data loss window | |
| Customers affected | |
| What made it slower than it should have been | |

That last row is the one that improves the next incident.
