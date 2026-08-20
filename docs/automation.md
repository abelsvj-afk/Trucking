# Automation & Autonomy

Phase 10 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Automation is only introduced after intelligence (Phase 9), permissions (`docs/governance.md`), and contracts (Phase 6) are defined — this document is where a *specific* capability finally moves past shared design into real, bounded scope. First (and only, for now) capability: the **industry intelligence engine**, chosen by the owner as the one to design first.

Every rule below only applies to this one capability. No other future capability in `docs/vision.md` is authorized by this document — each gets its own pass here when it's chosen next.

## What "autonomous" actually means here

This is worth being precise about, because "Level 5 autonomous" sounds bigger than it is: this capability is only ever authorized to (1) read external sources, (2) generate a briefing per the output contract in `docs/design/ai-architecture.md`, and (3) store it. It is never authorized to send anything, spend anything, or change anything about the business — those remain permanently forbidden actions per `docs/governance.md`, regardless of autonomy level. The autonomy being granted is narrowly about *when* it's allowed to run (unattended, on a schedule) — not about what it's allowed to decide on the business's behalf. If a future version of this capability ever starts producing "you should do X" recommendations instead of "here's what's happening," that's a scope change requiring its own governance review, not a natural extension of what's authorized here.

## Approval flow

None needed for individual runs — that's the point of the distinction above. A run that only reads and summarizes doesn't have a "step" that needs human approval the way sending an email or booking a load would. What *is* gated by explicit approval: **turning this capability on in the first place** (per `docs/governance.md`'s "raising the autonomy level is always an explicit, documented decision") and any change to its schedule bounds.

## Authorization checks

The scheduled job runs under its own scoped service credential — not a human user's session, since no human is present when it fires. That credential is deliberately narrow (least-privilege, per `docs/governance.md`):

- Read access to whatever sources `services/integrations` exposes for this capability — nothing else.
- Write access to `industry_briefings` only (per `docs/schemas.md`) — no access to any other table, not even read access to trucks/loads/expenses/etc. This capability has no legitimate reason to see the operator's business data, so it isn't given the ability to.
- No access to `services/db`'s write paths for any other resource, and no path to `services/api`'s user-facing write endpoints at all.

## Audit trail

Every run logs, per `docs/design/ai-architecture.md`'s mandatory logging: when it ran, which sources it used, the full output (`summary`/`reasoning`/`confidence`/`based_on`), and later, whether the owner dismissed it. A failed run logs the failure and why — never just silence.

## Revocation (the on/off switch)

Per `docs/governance.md`'s per-capability requirement:

- Checked immediately before every scheduled run starts. Off means the run doesn't start — not "runs but hides the result."
- If the switch is flipped off while a run is already in progress, that run is allowed to finish and its output is kept (it's just a summary — letting it complete costs nothing and there's no reason to throw away work that already happened), but no further run is scheduled until switched back on.
- Takes effect without needing the AI's cooperation, per `docs/governance.md` — it's a check the scheduler makes against stored state, not something the capability itself has to observe and honor.

## Rollback

Nothing to roll back in the traditional sense — this capability never changes anything outside its own `industry_briefings` table. A wrong or unhelpful briefing is dismissed (`dismissed_at`, per `docs/schemas.md`) exactly like any other record's soft-delete convention. There is no scenario where this capability's output needs to be "undone" from the rest of the system, because nothing else was ever touched.

## Failure recovery

If a source is unreachable or the AI call fails mid-run: the run fails explicitly (logged per Audit trail above), produces **no** briefing for that cycle — never a partial or low-confidence one dressed up as complete — and simply waits for the next scheduled run. No automatic immediate retry (that risks turning one bad source into a retry storm); the existing schedule interval is the retry cadence.

## Rate limits and timeouts

- **Schedule frequency:** bounded by the owner-set minimum interval from `docs/governance.md`/`docs/vision.md`. Default, until the owner changes it: **no more than once daily** — deliberately conservative, both because industry conditions don't usually change faster than that and because every run costs real API usage, which matters given the cost-consciousness already established for this project.
- **Per-run execution timeout:** a hard cap (a few minutes) so one hung external source or slow AI call doesn't run indefinitely. A timeout is treated exactly like any other failure per Failure recovery above.
- **Adaptive scheduling** (per the owner's earlier request): if built, it can only ever tighten or loosen the interval *within* the owner-set min/max bounds — it cannot widen its own bounds, only choose where inside them to run.

## Human escalation

A single failed run is routine and silent (per Failure recovery — no need to alert the owner every time one source hiccups). **Several consecutive failures**, or a source becoming chronically unreachable, escalates — surfaced to the owner rather than failing silently forever, per `docs/governance.md`'s escalation rules. Exact threshold (e.g. 3 consecutive failures) is an implementation-time tuning decision, not fixed here.

## Emergency shutdown

The per-capability switch in "Revocation" above *is* the emergency shutdown for this capability — there's no separate mechanism, because a capability this bounded (read + summarize, nothing else) has no scenario where a softer, non-emergency stop wouldn't already be enough. The global kill switch in `docs/governance.md` remains the system-wide backstop regardless.

---

*This document only covers the industry intelligence engine. The next capability chosen from `docs/vision.md` gets its own Phase 10 pass added here — the approval/audit/revocation/rollback/failure/rate-limit/escalation/shutdown questions above get asked fresh for each one, since a capability that can take a business-affecting action (e.g. future email outreach) will answer several of them very differently.*
