# Governance, Safety & Authority

Phase 4 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. This defines the boundaries of the system before it is given any intelligence or automation. Builds on `docs/vision.md` (non-goals) and `docs/user-stories.md` (workflows).

## Actors

- **Owner-Operator (human)** — the founder. Sole admin and sole authority right now. Per an explicit decision at the time this document was written, access stays single-admin for the foreseeable future; expanding it to a second person (full or view-only access) is a deliberate future decision, not a default to build toward.
- **AI layer (Abel, the assistant, and the scheduled jobs)** — exists and is in daily use (reconciled 2026-11-05; the earlier "does not exist yet" wording is retired). Its authority is defined **per capability and per tool** in `docs/ai-authority-matrix.md`; nothing runs with more power than that matrix and the Authority Levels below allow. Other agents (King, Claude) are described in `CLAUDE.md`'s coordination section; neither outranks the other and the owner decides.
- **External systems / integrations (future)** — load boards, fuel-price feeds, brokers, etc. Carry no inherent authority. Per `CLAUDE.md`, all external data is untrusted input requiring validation, never treated as instructions.

## Allowed actions

- The owner-operator may read, write, modify, and delete any data in the system — full authority, at all times.
- The AI layer, once built, may: analyze, classify, summarize, rank, predict, recommend, simulate, generate, and detect patterns (per the workflow doc's Phase 9 boundaries, already restated in `CLAUDE.md`).

## Forbidden actions

The AI layer must never, at any authority level:

- Expand its own permissions.
- Invent facts or fabricate data it doesn't actually have.
- Override this governance document.
- Modify protected systems (financial records, compliance data) without going through the approval workflow defined in `docs/user-stories.md`.
- Execute a restricted action — accepting/booking a load, sending a message to a broker/customer/driver, moving money — on its own initiative.
- Bypass an approval requirement, however inconvenient that approval step is.

No additional permanent restrictions beyond these are defined right now — the standard "AI recommends, human approves" rule is considered sufficient at this stage. (This was an explicit choice, not an oversight: if a specific hard limit — e.g. no permanent deletes, no unsupervised outreach — becomes necessary later, add it here explicitly rather than assuming it.)

## Authority levels

| Actor | Read | Write | Recommend | Approve | Execute | Delete | Modify |
|---|---|---|---|---|---|---|---|
| Owner-Operator | Yes | Yes | — | Yes | Yes | Yes | Yes |
| AI layer (current) | Yes (stored data, through read tools) | Only by **direct owner order** in his own message, or after his **yes** on a stored proposal; never self-initiated | Yes | No — it cannot approve its own proposal | Only the two cases under Write, plus the bounded unattended jobs in the matrix (which write briefings/signals/reports and message only the owner) | **Proposal only** (`delete_record`); never directly | Only through the same two cases |
| External integrations (future) | Only what's explicitly authorized per integration | No | No | No | No | No | No |

## Graduated autonomy

You've said the AI should start fully constrained, and gain autonomy over time once it's proven reliable — with a way to turn that up or back down. The system adopts the autonomy ladder from `My idea` as the model for that growth:

1. **Observe** — AI can read data and analyze internally; no recommendations are surfaced yet.
2. **Recommend** — AI surfaces recommendations with reasoning; the human decides everything.
3. **Prepare actions** — AI drafts the action (e.g. a draft email, a pre-filled load acceptance) without sending or submitting it.
4. **Human approves** — A specific, per-action human approval step executes the prepared action.
5. **Bounded autonomous execution** — AI may execute explicitly pre-authorized, narrowly-scoped, low-risk actions on its own, within hard limits defined in advance (e.g. a dollar cap, a fixed set of eligible actions).
6. **Autonomous narrow workflows** — AI handles one well-understood, narrow workflow end-to-end, still under strict, explicit limits.

**Current state (reconciled 2026-11-05): per capability, not one global level.** The system is **not** at Level 1. Conversation and dispatch handling operate at Levels 3–4 (prepare, then human approves); scheduled research, briefings, game-plan, maintenance and pay reporting operate at Level 2 (recommend/notify the owner only); memory consolidation stages changes at Level 3. **No capability executes a business-record write without either the owner's direct order or his yes, and none has been granted Level 5.** The classification is in `docs/ai-authority-matrix.md` §2 and awaits owner ratification; it describes existing behavior and grants nothing new.

**Autonomy is a real goal, not a hedge.** This project intends to actually climb this ladder over time, as trust in the system is earned — Level 5/6 (bounded and narrow-workflow autonomous execution) are things this system is meant to eventually reach, not capabilities being reluctantly permitted in theory. The constraint isn't "avoid autonomy" — it's "never grant autonomy silently, and never make it hard to pull back."

**Rule:** The system starts at Level 1 and only moves to a higher level through an explicit, documented decision by the owner-operator — never by default, never silently, and never just because a feature turns out to be technically capable of more. Raising the autonomy level for any capability is a Major Change under `CLAUDE.md`'s Change Control rules and requires this document to be updated *before* the change takes effect, not after.

## Escalation rules

- Anything the AI layer can't resolve confidently — missing data, conflicting data, a decision with significant financial impact — must be surfaced to the owner-operator rather than resolved by best guess (this is already the escalation workflow defined in `docs/user-stories.md`).
- No numeric thresholds (e.g. a specific dollar amount that always requires escalation) are defined yet. These should be set once there's real operating data to calibrate against, and must exist before any Level 5+ execution is designed — a Level 5/6 design without explicit thresholds is incomplete.

## Safety overrides

Per the workflow doc's Golden Principles ("Safety beats convenience"): when a safety concern and a productivity or automation goal conflict, the safety concern wins by default. Only the owner-operator can override that default, and only explicitly — never as a side effect of approving something else.

## Revocation

A single global switch isn't enough on its own: it forces an all-or-nothing choice when what's actually needed is the ability to shut off the one thing you don't like without losing everything else the AI does well. Revocation is therefore two-tiered:

- **Global kill switch.** The owner-operator must be able to revoke *all* AI authority and automation instantly, with a single obvious action, dropping the entire system back to Level 1 (observe-only). This always exists, regardless of what capabilities have been built. (Gaps G1–G2 in the matrix name the behaviors that do not yet have their own switch.)
- **Per-capability switches.** Every capability introduced at Level 5 or 6 (bounded or narrow-workflow autonomous execution — e.g. "auto-accept loads under $X," "auto-send a fuel-purchase confirmation") must ship with its own independent on/off control, separate from the global switch and from every other capability's control. Turning one off must never require touching, disabling, or reasoning about any other capability. A capability introduced without its own switch is not considered complete, whatever else it does.
- **No cooperation required.** Revocation — global or per-capability — must never require the AI's cooperation, acknowledgment, or approval to take effect. A human can always shut it off unilaterally, immediately.
- **Visible, not buried.** These controls (global and per-capability) must be surfaced prominently in the system's primary UI — not nested several menus deep — along with the current status of what the AI is authorized to do. See `docs/requirements.md`'s User Interface requirements. *How* the switches are technically implemented (a settings table, a config flag, a feature-flag service) is an architecture decision for a later phase; this document only establishes that they must exist, must be easy to find, and must always work.

## Core rule

AI must never silently expand its own authority. The system may only perform actions its *current* authority level in this document explicitly permits. Moving to a higher level is always a deliberate, human-made, documented decision — never an emergent side effect of a feature working well.

---

*This document governs authority and safety boundaries only. How those boundaries are technically enforced (auth systems, execution sandboxes, the revocation switch) is defined in `docs/architecture.md` and later phases.*


## Reconciliation record

2026-11-05 — retrospective audit Wave 1 (Phase 4): this document's Actors, Authority-levels and Current-state statements were corrected to the code, and `docs/ai-authority-matrix.md` added (capability levels, standing owner rulings, approval semantics, tool registry, revocation matrix, gaps G1–G5). Owner decisions requested are listed in `docs/reconciliation/2026-11-05-waves.md`.
