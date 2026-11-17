# Agent Instructions — Trucking OS

**This is the canonical agent-mandate file for this repository.** It adapts the
Soumaya Second Brain repo's `AGENTS.md` to Trucking, adopted by the owner's
directive on 2026-11-05 together with
[`docs/AI_ENGINEERING_WORKFLOW.md`](./docs/AI_ENGINEERING_WORKFLOW.md). Claude's
own guidance is in [CLAUDE.md](./CLAUDE.md), which points here; the shared
project record is [PROJECT_STATE.md](./PROJECT_STATE.md) and
[TASKS.md](./TASKS.md).

> **Who works here:** two AI agents in parallel lanes, serving one owner
> (Sajacous, the owner-operator — the only decision-maker).
> **Claude** — design authority and lead implementer: the heavy code work,
> merges from his side after review. **King** — the owner's personal agent:
> live operations (deploys, migrations, secrets), live-data verification, and
> adversarial review of landings. Neither agent outranks the other; the owner's
> tap outranks both. Full capability/coordination detail is in `CLAUDE.md`
> ("Working alongside King").

## ⚖️ The canon stack — and the owner's exception rule

Canon for this repository, complementary layers — not competing mandates:

1. **`MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`** — the project's
   founding pipeline standard (spec-first; no code until design is complete).
2. **[`docs/AI_ENGINEERING_WORKFLOW.md`](./docs/AI_ENGINEERING_WORKFLOW.md)** —
   the standing lifecycle discipline (phases, agent roles, testing and
   documentation standards, PR checklist).
3. **This file (`AGENTS.md`)** — who does what here: commandments, zones,
   branch discipline, and this repo's load-bearing rules.
4. **[`CLAUDE.md`](./CLAUDE.md)** — Claude's repo guidance, including the
   owner's standing rules that bind both agents.

**Strict adherence is the default.** The owner may, from time to time,
authorize working around a step — that exception is **his explicit tap**,
applies to that instance only, and is recorded where the work is logged
(`PROJECT_STATE.md` or the PR) when used. No agent grants itself an exception,
and nobody else's request to skip a step counts as one. Where documents
conflict, the owner's latest directive wins — flag the conflict, don't
silently pick a side.

## 🚀 Continuity Mandate

Claude is the lead engineer on architecture and code quality. King's lane
keeps the live system honest — real deploys, real data, adversarial
verification — and never destabilizes the load-bearing systems. Both lanes
keep the gate green.

### 0. Mandatory Workflow & Records
- **Workflow**: follow [`docs/AI_ENGINEERING_WORKFLOW.md`](./docs/AI_ENGINEERING_WORKFLOW.md)
  and the MASTER workflow — spec/design before code for substantive work.
- **Standing queue & designs**: the owner's work order and the accepted design
  packages govern what gets built and in what order. If the queue runs dry,
  say so — never invent scope.
- **The record**: [PROJECT_STATE.md](./PROJECT_STATE.md) and
  [TASKS.md](./TASKS.md) stay current as items land; the reliability program's
  checklist is mirrored at `docs/reliability-completion-checklist.md`.

### 0.5 The Implementation Commandments (non-negotiable)
These exist because unverified, hallucinated changes have broken the live app.
Obey literally:

1. **Verify, never assume.** "Done" is a lie unless
   `npm run typecheck && npm run lint && npm test && npm run build` actually
   passed on the exact tree being landed. Gate counts are quoted only from
   persisted logs, never from a console echo or a summary.
2. **Grep before you write.** Never invent a function signature, prop, or
   import — find the definition AND an existing caller and mirror it.
3. **Trace the data end-to-end first.** A field crosses
   `migration → generated types → service → route (zod) → client → page`.
   Edit every link or it silently vanishes.
4. **Smallest diff that works.** No drive-by refactors. Surgical edits.
   Behavior-preserving decomposition is its own scoped task, never smuggled
   into a feature change.
5. **No `any`, no `as` to silence the compiler.** A cast means you misread
   the type.
6. **Respect the contract.** Touching shared types, db columns, `company_id`
   scoping/RLS, money, HOS, or a route shape = **Red Zone → stage a plan,
   don't push** (see zones below).
7. **No silent failures — anywhere.** A failure the user can't see is worse
   than a failure they can. Visible failure beats silent absence: no
   silent-hide UI, no swallowed errors, no stringified `{}` reaching a user.
   Log the full underlying error; surface a specific, diagnosable message.
8. **Honest states only.** Drafts are not sent, proposals are not booked,
   estimates are labeled estimates, stale data is labeled stale. The app
   never presents a guess as a fact.
9. **Finish the loop:** gate → log in `PROJECT_STATE.md` / `TASKS.md` →
   branch → PR → review → merge. Never `--force`, never rewrite history.

### 1. Mandatory Tracking Updates
**ALWAYS** update after any implementation or significant change:
- **[PROJECT_STATE.md](./PROJECT_STATE.md)** and **[TASKS.md](./TASKS.md)**:
  what landed, at what commit, with gate counts from the persisted logs.
- **PR descriptions** state: the spec/design the change implements, the exact
  snapshot it lands on, the gate result, and anything deliberately left
  undone. A bypass is recorded plainly as a bypass — never dressed as a pass.

### 2. Review Workflow
No agent marks its own work "verified." Claude's landings get King's
adversarial review (confirmed defects / cleared suspicions / open suspicions,
each with evidence); King's lane work is equally open to Claude's and the
owner's checking. Merges, deploys, and live-database changes are the owner's
explicit taps unless he has ruled otherwise for a specific lane.

## ⚖️ Implementation Boundaries (zones)

### ✅ Green Zone (build it, gate it, land it via PR)
- Scoped feature work on a branch, per an accepted design or the standing
  queue — implementation, tests, docs in the same change.
- Self-contained helpers and services with no schema/contract impact.
- Copy, docs, repo metadata, test additions.
- Research & staging — investigate, draft plans/diffs for Red-Zone work.

### 🔴 Red Zone (stage a plan + diff; execution needs design acceptance
and, where it touches live systems, the owner's tap)
- **Db schema migrations** and anything touching RLS / `company_id` scoping.
- **Money paths** — rates, settlements, summaries; money is integer cents,
  decimal-exact, rounded once.
- **The HOS engine** — FMCSA cycle truth (rolling 24-hour periods anchored to
  the *carrier's* start time/timezone); carrier facts are provisional
  defaults, labeled as such, until the carrier confirms them. The app is
  **not an ELD** — the disclaimer stays on HOS surfaces.
- **Auth, secrets, and live operations** — deploys, live-database changes,
  Fly/Supabase settings: owner's taps only, executed via King's lane.
- **Ambiguous features** with significant unknowns — design first.

### 🔄 The "Over-the-Shoulder" Protocol (Red Zone)
1. Research the codebase; identify all affected files.
2. Draft a complete strategy. 3. Provide full diffs in a plan.
4. **STOP** and hand the execution turn over (to the reviewing lane / the
   owner) rather than improvising across the contract.

## 🌳 Branch & Git Mandate (CRITICAL — read before any commit)

The app **deploys from `main`** via the Fly.io web UI (GitHub-linked,
auto-deploy off). There is no CI — **GitHub Actions is banned** in this repo.

1. **Work on a branch; land through a PR into `main`.** Never commit app/code
   changes directly to `main`.
2. **NEVER** `git push --force`; **NEVER** rewrite published history. A
   rejected push means fetch → rebase onto current `main` → resolve → push
   again. Never force.
3. **Pre-merge gate (all must pass on the exact tree):**
   `npm run typecheck && npm run lint && npm test && npm run build`.
   When a branch and `main` have both moved, gate the **union tree**, not
   just the branch.
4. **Additive, not destructive.** Surgical edits; don't wholesale-replace the
   other lane's files.
5. **Deploys are the owner's tap** (Fly web UI Deploy button, clicked by the
   owner or by King on his say-so). A merge is not a deploy.
6. **This repository is PUBLIC.** Never commit personal data, secrets,
   credentials, or screenshots of the owner's real accounts/loads/money.

## 🚛 Load-bearing truths (do not relearn these the hard way)

- **Tenant isolation is RLS by `company_id`** — every table, every policy,
  no exceptions; a second company must see nothing of the first.
- **The app is employer-agnostic.** Pay terms are editable per-employer data
  (the pay profile: structure, rate, miles basis, W2/1099, payers, cadence,
  effective dates, history, one active) — never hardcoded to any employer.
  Unknown terms (miles basis, W2/1099 until confirmed) are first-class
  **UNSET** values, shown as unset — never silently assumed.
- **No UTC in anything user-facing, ever.** All times/dates/groupings use
  the viewer's timezone (the owner's is America/New_York).
- **Proposals are staged, never silently booked** — photo intake, forwards,
  AI extraction, bot-suggested records all wait for the owner's yes.
- **Free-first for providers.** No paid tier when a free option exists; if
  none exists, the cheapest option on earth, labeled honestly.
