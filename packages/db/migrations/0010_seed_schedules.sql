-- The recurring schedules the engine depends on.
--
-- `scheduled_jobs` has existed since 0008 and has been empty since 0008, which
-- means every reconciler written so far has been unreachable: the scheduler
-- reads due rows from this table and there were none. Recurring work is driven
-- from here rather than from BullMQ repeatables (R23) precisely so that the
-- schedule survives a Redis flush — but that only helps if the rows exist.
--
-- Seeded with ON CONFLICT DO NOTHING so `pnpm db:migrate` stays idempotent and
-- so an operator who disables a schedule in production does not have it
-- silently re-enabled by a later deploy.
--
-- `next_run_at` is now(), so each schedule fires on the first tick after the
-- migration rather than waiting out a full interval.

INSERT INTO scheduled_jobs (name, cron, queue, payload, next_run_at) VALUES
  -- R3/F3: `queued` rows whose job was never created, and R5/F5: provider
  -- attempts that outlived the point at which their outcome is knowable.
  -- Sixty seconds is the documented interval; the recipient sweep is the one
  -- reconciler whose lateness is measured in unsent mail.
  ('recipient-sweeper',  '* * * * *',    'recipient-sweeper',  '{}'::jsonb, now()),

  -- R12/F12: transient campaign states that have outlived their deadline, and
  -- R13: campaigns whose dispatcher died before it could run dry.
  ('campaign-reconcile', '* * * * *',    'campaign-reconcile', '{}'::jsonb, now()),

  -- Provider identity verification drifts without anyone touching Relayd: a
  -- DKIM record is changed, an SES identity is suspended. Fans out per
  -- workspace, so it needs no BYPASSRLS role (R20).
  ('provider-verify',    '*/15 * * * *', 'provider-verify',    '{}'::jsonb, now())
ON CONFLICT (name) DO NOTHING;


-- Deliberately not seeded here: `partition-maintenance` (R25). It has no queue
-- in packages/queue/src/queues.ts yet, and a schedule naming a queue that does
-- not exist fails on every tick. 0009 created two partitions ahead, which
-- covers the gap until Phase 7 adds the queue and its schedule together.


-- ROLLBACK:
-- DELETE FROM scheduled_jobs
--  WHERE name IN ('recipient-sweeper', 'campaign-reconcile', 'provider-verify');
