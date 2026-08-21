# AI Architecture (Intelligence Design)

Phase 9 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. `docs/vision.md` lists roughly nine future AI capabilities (decision engine, load profitability, fuel intelligence, industry intelligence, email AI, home-time engine, and more). Designing each one's prompt architecture and safety controls from a blank page would mean redoing the same work nine times, inconsistently — so this document defines **one reusable pattern every future AI capability conforms to**, then works it through fully for the capability most concretely specified so far: the industry-intelligence engine. This is the same "one worked example, everyone else follows the pattern" approach `docs/api-contracts.md` already used for API resources.

Nothing here authorizes building anything — Governance stays at Level 1 (per `docs/governance.md`) until a specific capability actually goes through its own remaining phases (Service Specs, Automation & Autonomy) and gets explicitly turned on.

## The pattern every AI capability follows

**Model:** an LLM called server-side only (never from the browser), API key handled exactly like any other secret in `docs/design/security.md`, accessed through a thin provider interface in `services/ai` (one function: take a system prompt + context + task, return text) rather than a specific vendor's SDK called directly from capability code. **Provider: OpenAI (the Chat Completions/Responses API)**, the owner's explicit choice as of Stage 4 — updated from this document's original assumption of Anthropic Claude (the natural default given the project itself is built with Claude, but not a requirement once the owner asked for OpenAI specifically). The interface is deliberately provider-agnostic so a second implementation (e.g. Anthropic) is a new file behind the same interface, not a rewrite — the owner has asked to keep that option open, not exercise it yet. Each capability still picks its own model/tier based on what it actually needs, not a global fixed choice.

**Prompt architecture:** every capability's prompt is built from three fixed parts — (1) a system prompt stating its specific, narrow purpose and the hard boundaries from `docs/governance.md` (what it may and may never do), (2) context assembled only from data the capability is actually authorized to read, and (3) the task itself. No capability gets a general-purpose "figure out what to do" prompt — each one's system prompt is as narrow as its actual job.

**Context strategy:** stateless, assembled fresh per run, always scoped to one `company_id` — tenant isolation (`docs/design/security.md`) extends to AI context exactly as it does to API responses; nothing crosses company boundaries because it's convenient for a prompt. Internal business data comes only through `services/db` (never a direct query); any external data (industry news, fuel prices, weather) comes only through a new reserved boundary, `services/integrations` (already anticipated in `docs/architecture.md`), and is treated as untrusted input requiring the same validation discipline as any external content per `CLAUDE.md` — never as instructions.

**Retrieval strategy:** none needed for internal data — it's structured business data queried directly through `services/db`, not unstructured text needing semantic search. If a future capability (e.g. the industry-intelligence engine) needs to work with unstructured external content (articles, reports), that's scoped when that specific capability is designed, not built speculatively now.

**Output contract:** every capability produces one of two shapes, so the UI (`docs/design/ui-ux.md`'s Approval workflow) can render any of them generically instead of needing bespoke UI per capability, and so "I don't have enough to say something real" is a machine-checkable status rather than free text a caller has to guess at from prose:

```json
{
  "status": "ok",
  "summary": "one-line plain-language recommendation",
  "reasoning": "why, in terms a human can verify",
  "confidence": "high | medium | low",
  "based_on": ["specific records or sources this used"],
  "options": [ /* optional: 2-3 ranked alternatives, each with the same shape, for capabilities like the decision engine's take/negotiate/decline choice from My idea */ ]
}
```
```json
{
  "status": "insufficient_data",
  "reason": "plain-language explanation of what's missing or why what's available isn't enough to say something real"
}
```

**Confidence handling & hallucination controls:** in the `"ok"` shape, `confidence` is mandatory, and `based_on` must name real, traceable records or sources — never invented ones. If a capability can't produce both, it returns `"insufficient_data"` instead of forcing an `"ok"` response with a weak `confidence: "low"` — it reports that it lacks enough data and stops, per `docs/governance.md`'s escalation rules and `CLAUDE.md`'s "AI must not invent unavailable data." No capability is allowed to fill a gap with a plausible-sounding guess. (`confidence: "low"` is still a real, distinct outcome from `insufficient_data` — it means "I have something to say, but it's thin," per the industry-intelligence worked example below; `insufficient_data` means there's nothing worth saying at all.)

`based_on` isn't just a prompt instruction the model is trusted to follow — a real gap found during Stage 5's security review (Stage 4's implementation only validated the *shape* of `based_on`, never that its contents actually referred to anything real). Every capability's output goes through a cross-check against the actual context it was given: each cited source must plausibly match something that was really in that run's context (a source label, a feed name, an item title). A citation that doesn't match anything real is treated the same as failing to produce `based_on` at all — the run fails per `docs/automation.md`'s Failure recovery, never a briefing built on an unverifiable citation.

**Feedback loops:** not built yet for any capability — no capability learns from past approve/reject decisions right now. What *is* required from day one: every recommendation, and what the human did with it (approved/modified/rejected), gets logged to the audit trail `CLAUDE.md` already requires. That log is exactly the raw material a future feedback loop would need — capturing it now costs nothing extra (it's the same audit trail already mandated for other reasons) and avoids having to retrofit logging later just to make learning possible.

**Ranking/scenario simulation:** not generic — defined per capability when it's designed (e.g. the decision engine ranking Option A/B/C, per `My idea` section 1). The `options` array above exists in the shared contract specifically so a capability that needs this doesn't need a different output shape.

**Memory:** still deliberately not designed (`docs/design/data-model.md`/`docs/design/testing.md` already deferred Memory Architecture in Phase 7). Every capability above is stateless per run — this holds until a specific capability genuinely needs to remember something across runs (e.g. "don't re-recommend the same thing every day"), at which point *that* capability's design is the place to design memory, not a speculative system built in advance for a need that doesn't exist yet.

## Worked example: the industry intelligence engine

Applying the pattern above to the capability from `docs/vision.md`:

- **Trigger:** runs on a schedule (Governance Level 5 — scheduled unattended execution is itself autonomous, even though the output is only ever a briefing), off by default, with its own dedicated kill switch per `docs/governance.md`. The schedule may later adapt to industry activity, bounded by an owner-set min/max interval.
- **Context:** pulls from `services/integrations` — sources chosen per `docs/requirements.md`'s Dependency Rule, both free at the MVP's "free/near-free to start" budget: the **EIA Open Data API** (U.S. Energy Information Administration's official weekly diesel retail price series — free, government data, no ongoing cost) for fuel-market data, and a small set of **public RSS feeds** (FMCSA's newsroom plus established trucking-industry outlets) for regulatory/industry-disruption content. Both are swappable/extensible later (e.g. a paid real-time pricing API) without changing the pattern — external, untrusted content either way, never treated as instructions.
- **System prompt boundary:** "summarize what's actually relevant to a small trucking operation; never recommend a specific business action" — this capability produces awareness, not decisions; if it starts drifting into "you should do X," that's a prompt-boundary bug, not a feature.
- **Output:** the shared contract above — `summary`/`reasoning`/`confidence`/`based_on`, surfaced in the "Industry intelligence briefing" screen already placeholder-listed in `docs/design/ui-ux.md`.
- **Confidence handling:** if the sources for a given run are thin or contradictory, `confidence: "low"` and it says so plainly — it doesn't smooth that over to sound more useful than it is.

## What's still explicitly out of scope

Per the pattern's own logic — no capability is designed further than this until it goes through Phase 8-equivalent service specs and Phase 10 automation/autonomy review for *that specific capability*. This document is the shared contract, not a green light to start building any of the nine future capabilities in `docs/vision.md`.

---

*This is the last purely-design phase before automation gets designed (Phase 10) and repository/roadmap/task planning (Phases 12-14) turn any of this into actual implementation work.*
