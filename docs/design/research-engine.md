# Deep Research Engine — pressure-triggered in-app research (capability: `deep_research`)

Written 2026-10-31, ahead of code, per this repo's spec-first workflow
(`CLAUDE.md`). Owner-authorized the same day (Wave D, promoted by his
direct order): *"the research agent lives IN THE APP. It watches for
PRESSURE — market and industry signals… when pressure registers, it
kicks off research automatically, works through the findings, fixes
what's in its remit or tells me, and keeps me updated."*

This grows the existing Industry Intelligence seed (Stage 4:
`industry_briefings`, `services/ai/run-industry-briefing.ts`, the EIA +
RSS integrations, the kill-switch pattern, the scoped job credential)
into the engine `Trucking-App-Vision-and-Roadmap.md` §3 specifies. It
does **not** replace that seed: `industry_intelligence` stays its own
daily-awareness capability; `deep_research` is the deeper, rarer,
pressure-triggered tier the vision doc's "Tiered effort" paragraph
reserves full passes for.

## 1. What it is, in one paragraph

Server-side **watchers** poll free/public sources on a cadence and turn
what they see into normalized **pressure signals** (stored, with a
magnitude). A **trigger engine** decides — from signal thresholds, a
twice-monthly baseline cadence, hard run caps, and the kill switches —
whether to queue a **research run**. A run gathers its topic's stored
signals/items, calls the existing `AiProvider` with a Secrets-Brief-
format prompt (findings with real sources, what changed, the
counter-move for a one-truck operation, unverified items marked), and
stores the result as a **briefing** (data, not files). Briefings surface
in the app (More → Research, with unread state) and a one-line summary
pushes to the owner's Telegram when the bot is configured. Quality bar:
the King-produced `Secrets-Brief-01` / `Research-Briefing-2026-10-31`
documents in the own-truck goal files — sourced claims, counter-moves,
unverified marked, never smoothed over.

## 2. Watchers (`src/services/research/watchers/`)

A registry of watchers. Each poll returns `{ status, signals, state }`
and **never throws past the registry**: a failure is recorded in
`research_watcher_state` (`last_status='error'`, `last_error`,
`last_polled_at`) and shown on the Research page — visible, never
silent (owner's spec). Watchers are keyless-first:

| Watcher | Source | Key? | Signal |
|---|---|---|---|
| `eia_diesel` | EIA API v2 weekly retail diesel, U.S. avg (same series as Stage 4) | Free key (`EIA_API_KEY`) when present; **graceful skip** without it (`status='skipped'`, reason recorded — the key's free registration is an owner setup item, see §8) | One observation signal per new weekly period; carries the week-over-week % change, which is what the trigger threshold reads |
| `federal_register` | Federal Register API (`federalregister.gov/api/v1`), FMCSA agency, RULE + PRORULE documents | None — free, no key | One signal per new document; magnitude high for a final RULE matching tracked keywords (HOS, ELD, insurance minimums, speed limiter, clearinghouse, emissions, broker transparency), medium for proposed rules / non-matching finals |
| `industry_news` | The Stage-4 RSS feeds (FMCSA Newsroom, FreightWaves, Overdrive) via `services/integrations/rss.ts` | None | **Burst** signals: ≥ `NEWS_BURST_MIN_ITEMS` items inside the poll window matching the same tracked topic cluster (fuel, rates/market, regulation, carrier failure/layoffs, technology/electric) |

Every signal row stores the raw items it was built from (title, link,
published date, summary) in `research_signals.items` — that stored
evidence is what a later run reads, so a run never depends on re-
fetching a feed that has since rotated.

Dedup: `research_signals.dedupe_key` is unique (e.g.
`eia_diesel:2026-10-26`, `federal_register:<document_number>`,
`news_burst:fuel:2026-10-31`) — re-polling the same source state never
double-signals or double-triggers.

## 3. Trigger engine (`src/services/research/triggers.ts`)

Pure, unit-tested decision logic. Inputs: now, per-company run history
(last baseline run, runs today, runs this month), fresh signals.
Outputs: zero or more run decisions `{ kind, topic, reason, signalIds }`.

- **Baseline:** a `scheduled` run ("Industry & market briefing") when
  the last baseline run is ≥ `RESEARCH_BASELINE_INTERVAL_DAYS`
  (default **15** — twice-monthly, the vision doc's starting cadence)
  ago, or never.
- **Pressure:** a `pressure` run when any fresh signal crosses its
  threshold:
  - diesel |week-over-week change| ≥ `RESEARCH_DIESEL_THRESHOLD_PCT`
    (default **3%**);
  - a federal-register signal with magnitude ≥ 0.8 (final rule,
    tracked keyword);
  - a news-burst signal (magnitude scales with item count).
- **Manual:** the owner queues a run himself ("Research this now",
  §6). Manual runs are picked up by the same engine tick.
- **Caps (hard, checked in SQL counts against `research_runs`, not
  memory):** `RESEARCH_MAX_RUNS_PER_DAY` (default **2**),
  `RESEARCH_MAX_RUNS_PER_MONTH` (default **10**). A decision that would
  exceed a cap is **not dropped silently**: it is written to the run
  log as `skipped_cap` with the cap named, so the owner can see the
  engine wanted to run and was held back.
- **Kill switches (non-negotiable, owner's existing pattern):** the
  whole engine is behind the new `deep_research` capability in
  `ai_capability_settings`, **default OFF**, plus the global
  `companies.ai_globally_disabled` switch — checked by the eligibility
  query before any watcher-driven run executes, exactly like
  `run-industry-briefing.ts`'s `getEligibleCompanies`. Watchers
  themselves poll regardless (they cost no AI spend and their signals
  are the archive), but **no AI run ever executes for a company whose
  capability is off**. A queued manual run for a disabled company is
  logged `skipped_disabled`, not executed.

Thresholds/caps are env-overridable constants (documented in
`.env.example`), the same treatment Stage 4 gave
`INDUSTRY_BRIEFING_INTERVAL_MS`.

## 4. Research runner (`src/services/research/run-research.ts`)

Follows `run-industry-briefing.ts`'s shape deliberately: takes a
`Queryable` (the scoped job pool — see §7) and an `AiProvider`, never
throws; every outcome lands in `research_runs`.

One run:
1. Claim the decision (insert `research_runs` row, `status='running'`).
2. Gather context: the triggering signals' stored items + recent
   signals on the topic + the watchers' latest observations. No live
   re-fetch mid-run beyond what watchers already stored (honest scope:
   targeted fetching is limited to the watcher layer in v1).
3. Generate via `services/ai/research-briefing.ts`: its own prompt +
   Zod output contract in the Secrets Brief shape — `title`,
   `headline`, `findings[]` (each: claim, source title, source URL),
   `what_changed`, `counter_move` (the so-what for a one-truck
   operation), `takeaway` (exactly one learn/do), `unverified[]`,
   `confidence`. Same grounding discipline as Stage 4: every finding's
   source must plausibly match a source the context actually contained
   (title or URL), or the run fails loudly — **no sources, no
   briefing** (vision §3).
4. Persist `research_briefings` row; mark the run `success` (or
   `insufficient_data` / `failure` with the reason logged).
5. Notify (§5).

## 5. Delivery

- **App:** More → Research page — briefing cards (unread dot until
  opened/read), findings with tappable source links, what-changed,
  counter-move and takeaway called out, unverified section rendered as
  its own marked block, plus an engine panel: watcher health (last
  poll, ok/error/skipped + reason), recent run log (kind, topic,
  status), runs used today/this month vs caps, and the
  "Research this now" form.
- **Telegram:** on a successful run, one summary message (headline +
  takeaway + "open the app → More → Research") via the existing bot
  config (`TELEGRAM_BOT_TOKEN` + `TELEGRAM_ALLOWED_CHAT_ID`, the same
  env the webhook uses). Best-effort and honest: a failed send is
  logged and `telegram_notified_at` stays null; it never fails the
  run. No send happens when Telegram isn't configured.
- **"Fixes it" scope — honestly bounded for v1:** the engine updates
  only its own tracked state (signals, watcher state, run log,
  briefings). It does **not** write to loads, money, compliance, or any
  operational table. Propose-style fixes (e.g. a compliance-calendar
  item from a rule change) ride bot-intelligence-v2's
  pending-actions pattern, which lives on another branch; the
  follow-up is recorded in TASKS.md (task 8.7), not improvised here.

## 6. Manual trigger

`POST /api/v1/research-briefings/research-now { topic }`
(authenticated owner session) inserts a `research_runs` row with
`trigger_kind='manual'`, `status='queued'` — the **only** client-side
insert into engine tables, fenced by an RLS policy that requires
exactly that shape (own company, manual, queued). The scheduler tick
executes queued runs subject to the same caps and kill switch. The
Research page's form uses this endpoint.

## 7. Data & credentials (migration `00019`)

Tables (full column contract in `docs/schemas.md`):
`research_signals`, `research_watcher_state`, `research_runs`,
`research_briefings`. Numbering starts at 00019: 00015/00016 belong to
the bot-intelligence-v2 branch, 00017/00018 are reserved for the
Smart Path branch.

Credential: the engine runs under the **same scoped job credential**
as Stage 4 (`INDUSTRY_BRIEFING_DB_URL`, role `industry_briefing_job`);
migration 00019 extends that role's grants to the four research
tables and nothing else, with the same defense-in-depth RLS policies
00008 established. No new password, no service-role key, no new env
var required to run.

## 8. Owner setup items (flagged, not blockers)

- **`EIA_API_KEY`** — free registration at eia.gov. Without it the
  diesel watcher skips gracefully (visible on the Research page) and
  fuel pressure is inferred from news only. With it, exact EIA
  week-over-week diesel triggers work. (Same key Stage 4 already
  documents.)
- Turning the capability on: Settings → "Deep research engine"
  (ships OFF — autonomy never starts spending without his tap).
- Telegram summary pushes need the bot setup from Driver MVP §4
  (already an owner setup item there).

## 9. Scheduling

The Stage-4 scheduler's hourly check-in pattern
(`services/ai/scheduler.ts`, started from `instrumentation.ts`) gains
a research tick: poll watchers → store signals → per eligible company,
evaluate triggers → execute due runs (baseline, pressure, queued
manual). DB state (watcher state, run counts) decides what's due —
never in-memory timers — since Fly restarts the process freely.
