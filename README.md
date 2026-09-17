# Relayd build plan — how to use this with Claude Code

This folder is the implementation package for Relayd, an email campaign orchestration SaaS. It contains the full technical design, the independent adversarial review that corrected it, and a phase-by-phase build plan with the corrections already applied.

## What is in here

| File | Purpose | Read when |
|---|---|---|
| `CLAUDE.md` | Operating manual for Claude Code: locked stack, repo layout, commands, architecture rules, lint rules, the things never to do, and the decision defaults | Every session (Claude Code loads it automatically) |
| `INVARIANTS.md` | 36 rules that must never break, each with the test that proves it and a column to record the test path once written | Before any work on the send path, billing, or tenant scoping |
| `BUILD-PLAN.md` | Phases 0–12 as checklists with gates. The thing you execute | Start of every phase; tick boxes as you go |
| `docs/00`–`docs/16` | The full Technical Design Document, split by topic | As referenced from each phase in `BUILD-PLAN.md` |
| `docs/17-review-findings.md` | The adversarial review: 34 findings, traces, fixes, revised architecture, DB/API/queue changes | Before Phases 3, 5, 6, 7, 8 |

Precedence when documents disagree: `INVARIANTS.md` → `docs/17-review-findings.md` → `BUILD-PLAN.md` → `docs/00`–`16`.

## Setup

1. Create the repository and copy this folder's contents into its root:

   ```bash
   mkdir relayd && cd relayd && git init
   cp -r /path/to/relayd-build-plan/. .
   ```

   `CLAUDE.md` must sit at the repo root. Keep `docs/`, `INVARIANTS.md` and `BUILD-PLAN.md` at the root too; the plan references them by those paths.

2. Start Claude Code in the repo root and give it the first instruction:

   ```
   Read CLAUDE.md, INVARIANTS.md and BUILD-PLAN.md in full. Then read the docs listed
   under Phase 0. Confirm you understand the precedence order and the decision defaults
   in CLAUDE.md section 13. Then begin Phase 0. Work one checklist item per commit.
   Stop and show me when the Phase 0 gate criteria are met.
   ```

3. For each subsequent phase:

   ```
   Phase N gate is confirmed. Begin Phase N+1. Read its "Read first" docs and the
   INVARIANTS rows it lists before writing code. For every INVARIANTS row, write the
   proving test first, then the implementation, then record the test path in INVARIANTS.md.
   ```

## Working rules that make this go well

- **Hold the gates.** Do not let a phase start while the previous gate is red. The gates are where schedule pressure gets caught.
- **Answer the decisions early.** `CLAUDE.md` §13 lists D1–D7 with the defaults Claude Code will build to. D1, D2, D3 and D7 gate Phases 3, 6 and 8. If you want something other than the default, change the table in `CLAUDE.md` before that phase starts and tell Claude Code you did.
- **Protect Phases 8 and 11.** If Phase 6 runs long, the plan says to cut pool routing to single-sender sending. It does not say to compress billing or anti-abuse. Hold that line.
- **Keep the docs honest.** When Claude Code finds a design error, have it fix the doc and note the change in `docs/16-self-review-and-decisions.md`, not just the code. The docs are load-bearing for every later phase.
- **Week one is a vertical slice**, not a wizard: one user, one workspace, one SES connection, one contact, one send, one delivery event ingested. If Claude Code drifts toward building UI first, point it back to `CLAUDE.md` §5.

## Companion deliverables

- `Relayd-Technical-Design-Document-v0.1.pdf` — the same content as `docs/`, typeset for reading and sharing (Part I design, Part II review).
- `Relayd-Architecture-and-Review.pptx` — 21-slide mixed-audience deck: product, architecture, billing, security, roadmap, review findings, decisions, approval gate.
