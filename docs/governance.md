# Governance, Safety & Authority

Phase 4 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. This defines the boundaries of the system before it is given any intelligence or automation. Builds on `docs/vision.md` (non-goals) and `docs/user-stories.md` (workflows).

## Actors

- **Owner-Operator (human)** — the founder. Sole admin and sole authority right now. Per an explicit decision at the time this document was written, access stays single-admin for the foreseeable future; expanding it to a second person (full or view-only access) is a deliberate future decision, not a default to build toward.
- **AI layer** — does not exist yet as a built capability. The recommendation-style behavior described in `docs/vision.md` and `docs/user-stories.md` is aspirational and is gated entirely by this document — nothing described there is authorized to run with more power than the Authority Levels below allow.
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
| AI layer (current) | Yes (on stored data, once built) | No | Yes (once built) | No | No | No | No |
| External integrations (future) | Only what's explicitly authorized per integration | No | No | No | No | No | No |

## Graduated autonomy

You've said the AI should start fully constrained, and gain autonomy over time once it's proven reliable — with a way to turn that up or back down. The system adopts the autonomy ladder from `My idea` as the model for that growth:

1. **Observe** — AI can read data and analyze internally; no recommendations are surfaced yet.
2. **Recommend** — AI surfaces recommendations with reasoning; the human decides everything.
3. **Prepare actions** — AI drafts the action (e.g. a draft email, a pre-filled load acceptance) without sending or submitting it.
4. **Human approves** — A specific, per-action human approval step executes the prepared action.
5. **Bounded autonomous execution** — AI may execute explicitly pre-authorized, narrowly-scoped, low-risk actions on its own, within hard limits defined in advance (e.g. a dollar cap, a fixed set of eligible actions).
6. **Autonomous narrow workflows** — AI handles one well-understood, narrow workflow end-to-end, still under strict, explicit limits.

**Current state: Level 1.** No AI decision-making capability has been designed or built at all yet — this ladder exists to describe how far the system is *allowed* to go over time, not what exists today.

**Rule:** The system starts at Level 1 and only moves to a higher level through an explicit, documented decision by the owner-operator — never by default, never silently, and never just because a feature turns out to be technically capable of more. Raising the autonomy level for any capability is a Major Change under `CLAUDE.md`'s Change Control rules and requires this document to be updated *before* the change takes effect, not after.

## Escalation rules

- Anything the AI layer can't resolve confidently — missing data, conflicting data, a decision with significant financial impact — must be surfaced to the owner-operator rather than resolved by best guess (this is already the escalation workflow defined in `docs/user-stories.md`).
- No numeric thresholds (e.g. a specific dollar amount that always requires escalation) are defined yet. These should be set once there's real operating data to calibrate against, and must exist before any Level 5+ execution is designed — a Level 5/6 design without explicit thresholds is incomplete.

## Safety overrides

Per the workflow doc's Golden Principles ("Safety beats convenience"): when a safety concern and a productivity or automation goal conflict, the safety concern wins by default. Only the owner-operator can override that default, and only explicitly — never as a side effect of approving something else.

## Revocation

- The owner-operator must be able to revoke any AI authority or automation instantly, with a single obvious action, dropping the system back to at least Level 1 (observe-only). This is the "on/off switch" you asked for — this document establishes the requirement; *how* it's implemented (a settings toggle, a config flag, etc.) is an architecture decision for a later phase.
- Revocation must never require the AI's cooperation, acknowledgment, or approval to take effect. A human can always shut it off unilaterally, immediately.

## Core rule

AI must never silently expand its own authority. The system may only perform actions its *current* authority level in this document explicitly permits. Moving to a higher level is always a deliberate, human-made, documented decision — never an emergent side effect of a feature working well.

---

*This document governs authority and safety boundaries only. How those boundaries are technically enforced (auth systems, execution sandboxes, the revocation switch) is defined in `docs/architecture.md` and later phases.*
