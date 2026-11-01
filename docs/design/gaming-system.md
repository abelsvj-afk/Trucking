# Gaming System — the Game Plan

The owner's "game my life" layer: he names an outcome ("be rich by
[date]" becomes a metric, a number, a date, and a posture), and the
app games his **real numbers** into the most honest path to it —
conservative (trucking only) and mixed (trucking + side income)
side by side — then tracks him against it monthly. This doc is the
in-repo summary of the ratified design; the full design record
lives with the goal files (`Gaming-System-Design.md`). The fences
below are binding on the code.

## The shape

- **One active target** (`game_targets`): metric
  (`monthly_net_cents` | `truck_fund_cents` | `business_value_cents`
  | `net_worth_cents`), value, optional date (blank = open-ended,
  gamed over 24 months), and a **posture** — conservative, or mixed
  with a slider (`posture_mix_pct`): the share of the gap side
  income is *permitted* to carry. Posture is a permission, not a
  prediction. Any edit auto re-games.
- **Snapshot** (`services/game/snapshot.ts`): built from his real
  records only — settled income at 4/8/12-week windows (pace uses
  the 8-week middle), trailing-90-day cost structure, Truck Fund
  state and his *actual* savings rate, capacity from duty logs,
  research briefings, recorded skills, hand-recorded account
  snapshots. Short history (< 4 settled loads OR < 4 weeks) stamps
  the plan **THIN DATA** wherever it renders.
- **Deterministic engine** (`src/lib/game-plan.ts`): code does all
  the math; the model only narrates, and its narration is checked
  in code (banned promise language; every dollar figure must trace
  to the plan's own numbers — one retry, then the run fails loud
  and stores nothing). Three lines always — current pace,
  conservative, mixed — plus the **recommended** path: conservative
  + cited side levers admitted only up to the posture allowance.
  The gap block itemizes each lever's contribution (engine
  arithmetic: re-run with and without) and, when no path closes
  the gap, names the only three honest closers: move the date,
  move the number, or add a lever.
- **Milestones**: the truck window (first month the fund covers
  price + repair reserve + authority startup) and the authority
  filing under the **aging rule, enforced in code**: activation is
  legal only if the truck window falls within ~6 months after it
  AND the fund at activation covers the truck-side targets plus a
  full insurance year. An early desired month is pushed to the
  truck window with the reason stated in one line. S-corp zone
  (~$40k+ trailing net) is flagged for a CPA conversation, never
  filed. **Hire #1 is a named later increment — not modeled in v1.**
- **§3.4 fence**: a side-income lever exists for planning only when
  it cites a source the snapshot surfaced — a `research_briefings`
  id or one of his recorded skills in `bot_memories`. Enforced in
  `buildAssumptions`, not in a prompt. Generic hustle content is
  banned output.
- **STABILIZE validity fence (§5.5)**: a game whose recommended
  path breaks a Finance rule — financing while the cushion runs
  below its floor (**leverage before cushion**), an authority
  window whose insurance year the fund can't hold (**insurance
  lapse**), a week past the 61.25 on-duty-hour ceiling (**HOS
  illegal**), or a path that spends the cushion below zero where
  his pace doesn't (**cushion spend**) — is stored as
  `invalid_rules` and replaced with the **nearest valid plan**
  (financing zeroed, side levers dropped newest-first until legal,
  early activation cleared), which says out loud what it removed.
  A financed path the owner asks about still renders — as a
  labelled what-if with the broken rule named.
- **Versioning**: every game is a new `game_plans` version with a
  **code-computed diff** vs the previous current (gap delta, window
  moves, assumption changes; materiality threshold, default 2% of
  target). Never a silent overwrite.
- **What-ifs** (§2.3): assumption overrides gamed into a `what_if`
  version. They never touch real data and **never auto-promote** —
  promotion is the separate explicit "make that the plan"
  (`promoteWhatIf`), which adopts the frozen what-if as-is.
- **Persistent overrides** (§2.5): standing assumptions live in
  `bot_memories` kind `game_assumption` (JSON `{"key","value"}`;
  migration `00026` admits the kind). Listed and clearable via the
  bot tools; excluded from conversational memory retrieval — they
  are machine data for the engine.
- **Checkpoints** (§4.3): monthly close (America/New_York) grades
  the just-ended month — planned (from the plan he started the
  month on) vs actual, verdict within a ±2% band — and sends ONE
  Telegram digest: verdict, one-line cause, the single next-month
  lever. Information only, never an action. Idempotent by unique
  index. The unattended path (hourly tick in
  `instrumentation.ts`) runs under the service-role client scoped
  in code to `TELEGRAM_COMPANY_ID`, like the Telegram store.
- **Governance**: the `game_plan` capability ships **OFF** (global
  switch first, then per-capability, no row = off). Re-games are
  capped at **4/day**, counted from `game_plan_runs` — every
  attempt lands there (success, failure, `skipped_cap`,
  `skipped_disabled`, `invalid_replaced`), never from memory.
  Triggers: target set/edit, settlement, fund milestone, research
  briefing, maintenance ≥ $500, checkpoint, manual, what-if —
  data triggers evaluate at most once per day.

## Surfaces

- **More → Game Plan**: target header + editor, the trajectory
  chart (hand-rolled SVG — no chart library in this repo), gap
  block, milestone spine, demands block (hours vs the legal
  ceiling, required vs actual sweep, thinnest-cushion month),
  plain-words narration, assumption sheet with per-value sources
  (vision estimates carry ⚠️ VERIFY), what-if form + promote,
  version history, checkpoint scoreboard.
- **API**: `docs/api-contracts.md` "Gaming System" section.
- **Bot tools** (`services/bot/tools-game.ts`): `get_game_plan`,
  `set_game_target` (his direct command executes immediately —
  §1.3), `game_what_if`, `promote_game_plan`,
  `save_game_assumption`, `clear_game_assumption`. Game writes are
  direct-invocation only, never staged inside dump batches.

## The five owner decisions — shipped defaults, his to overrule

1. **Default metric: `monthly_net_cents`** — the number his records
   feed today. (Net worth renders "partial: business-only" until
   accounts connect; business value is labelled crude by design.)
2. **The mixed path renders even at conservative posture**,
   labelled declined-by-posture — he sees what he's saying no to.
3. **Checkpoint cadence: monthly.**
4. **What-ifs never auto-promote** — explicit adoption only.
5. **Emergency-cushion floor: $10,000, READ from the Finance
   Project rules** (`EMERGENCY_FUND_TARGET_CENTS` in
   `lib/truck-fund.ts`). Gaming reads it; it never sets it.

## Honest bounds (v1)

- **Plaid is not in this build** — documented seam only (Truck Fund
  §9.5). Net worth is business value + hand-recorded personal
  snapshots, rendered partial.
- **The MC-age clock reads `not_started`** — no authority-
  activation record exists in the schema yet, so plans use the
  aging decision rule instead of a live clock.
- **Business value is deliberately crude**: fund balances + the
  truck's price once purchased − known debts.
- Vision-doc estimates (repair reserve $5,000; authority startup
  $12,000 of an $8–20k range; insurance $13,000/yr of an $8–18k
  range) are planning placeholders with VERIFY framing until his
  real quotes replace them via overrides.
- Migrations `00024`–`00026` are additive with tenant-isolation
  RLS like every other table. They are **not applied** by the
  build — the merge-time Supabase step applies them, then the
  owner deploys and flips "Game Plan" ON in Settings.
