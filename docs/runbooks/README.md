Written for: whoever is on call, reading this at 3am under pressure.

# Runbooks

One file per situation. Each is written to be followed, not studied: the
first thing in every file is what to do, and the reasoning is underneath it.

| Runbook | When |
| --- | --- |
| [restore-drill.md](restore-drill.md) | The quarterly timed drill. Also the reference for a real restore. |
| [disaster-recovery.md](disaster-recovery.md) | Region loss, accidental deletion, or a bad deploy. |

## The three rules that apply to all of them

**Never restore over production.** A PITR restore always creates a *new*
instance. You extract from it and reinsert. Restoring in place destroys the
evidence of what went wrong and turns a recoverable incident into an
unrecoverable one, and it cannot be undone.

**The clock starts when you decide, not when you understand.** RTO is one
hour (docs/10). The hour includes the fifteen minutes you spend working out
what happened. If you are not sure, start the restore into a new instance
anyway — it costs a few dollars and it runs while you think.

**Write down the timestamps as you go.** Every runbook has a table for them.
The drill is worthless without them, and during a real incident they are what
the post-mortem is built from — nobody reconstructs them accurately
afterwards.

## What is not written down here

Anything that needs credentials, an account number or a hostname. Those live
in the environment, in Terraform outputs and in the password manager. A
runbook that embeds them goes stale silently and is wrong exactly when it
matters.
