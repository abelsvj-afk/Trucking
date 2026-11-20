# Bot team build plan — Road to Legacy Trucking

Owner: Sajacous Smith. Goal: be his own dispatcher / owner-operator, run
the business the legit way, with a team of bots that is ready when he breaks
off solo. He still drives for Steven (1099, 55c/mile) — **no booking work
right now**. Build the bots so they can do the work; do not book anything.

Spec of record: the 7 bots' governing files (`docs/bots/` — PR #95,
branch `feat/bot-team-governing-files-2026-11-19`, NOT merged yet). Each bot:
governing CLAUDE.md, SOUL.md, injectable MEMORY.md. The files are the
rulebooks; this plan is the build order. Team map: the bot-team-map artifact
(visual for the owner; the bots read their own files, not the map page).
Dispatcher playbook: the dispatcher-profit-playbook artifact (profit per ALL
miles, never book into Florida without the exit priced, counter every load,
vet brokers, detention/layover on the rate confirmation).

Standing rules (owner, do not relax):
- Propose-only, always. No bot books, pays, messages a broker, signs, or
  touches HOS/money on its own. Every action is a proposal; the owner's tap
  approves. An approval unanswered by its deadline counts as denied.
- Auditor (read-only, flag only) checks every draft — miles, pay math,
  times, addresses vs the source — before it reaches the owner.
- NOTHING from Steven's company in the app: no carrier legal name, DOT/MC
  numbers, insurance, filings, driver file, or drug-testing program.
- Owner sees everything. A future hired driver sees only their own loads,
  pay, hours, and documents, through their own 1-to-1 Driver Agent — never
  the group chat, never the dispatch board, never broker rates.
- Money is integer cents, decimal-exact, rounded once. Every table is RLS
  by `company_id`. No UTC in anything user-facing.
- One shared calling number (+1 320-369-0102, Telnyx) in his ElevenLabs
  voice. Bots take turns, never two at once. NEVER offer a human handoff
  unless the person explicitly asks — the bot handles the call, connects
  him only on request. Every call logged.
- Signature: private secure storage only, never in the repo/chat/bot
  files. A bot shows the exact document first; he approves THAT exact
  document; only then is the signature placed. Every signing logged.
  The signature pad exists but is EMPTY — no signature on file yet.
- Email split: Abel owns owner@, Dispatch Scout owns dispatch@.
- Engine: his ChatGPT API key (topped up $10 at a time). Cheap model to
  scan, stronger model only to rank the best few, hard spending cap.
- Storage: Supabase (cloud Postgres, project ref `qiiztjqzlrpffyyrjkss`).
  Each bot its own identity/memory, plus a shared load ledger and audit
  log. The learn-from-every-load loop's raw material lives in the ledger:
  pay, miles, deadhead, fuel, outcome for every booking/cancellation/
  success/failure.
- Workflow: King builds the baseline, Claude builds on top, ChatGPT audits
  separately on the owner's own time (do NOT cue him about the audit).
- Repo is PUBLIC. Never commit secrets, personal data, or real-account
  screenshots. GitHub Actions are banned. Deploys are the owner's tap via
  the Fly web UI (guard shows the expected commit); a merge is not a deploy.

## Architecture decision (baseline)

**Extend the existing Fly app "trucking" — no separate service.**
The app already has the Telegram webhook, the bot brain store, the OpenAI
provider, the Supabase wiring, and the Fly secrets (TELEGRAM_BOT_TOKEN,
TELEGRAM_WEBHOOK_SECRET, OPENAI_API_KEY). A separate service would duplicate
all of that, add a second bill, and split the brain in two. The bot backend
lives in `src/services/bots/` inside the same Next.js app, on the same
machines (which already sleep when idle: `auto_stop_machines = 'stop'`).
Cheapest/free-first, and one deployment to watch. If the bot load ever
outgrows the app (it will not at one truck), splitting it out is a later
decision, not a baseline one.

## Phase 0 — Baseline (this build, branch `feat/bot-team-baseline-2026-11-19`)

1. Supabase schema (migration `00103_bot_team.sql`; 00102 is claimed twice
   by unmerged B1/B8 branches, so this build starts at 00103): bot
   identities, per-bot memory, shared load ledger, audit log of every
   proposal and owner decision, group-chat rooms/memberships. RLS by
   `company_id` on every table. Migration is AUTHORED, NOT applied — the
   live apply is the owner's tap, via King's lane, before any deploy.
2. Bot registry in code: the 7 bots, each with its tool scope from its
   governing file (Abel full set gated; Dispatch Scout read + draft only;
   Auditor read-only, flag only; the rest scoped per job). The gateway
   hides every tool a bot is not allowed — a bot cannot call what it
   cannot see. Propose-only enforced in code, not just in the MD files.
3. Telegram group wiring for the FIRST TWO seats only: Abel (already
   @AbelExecutiveBot, owner's chat 8975172276) and Dispatch Scout. Group
   mode does not exist yet for Abel (1:1 only today) — build it: one
   private group, him + bots, every bot hears every message, only the
   relevant one answers, the rest stay quiet.
4. Auditor check in the pipeline: every draft is recomputed (miles x rate
   = pay, $ per loaded mile, $ per ALL miles) and compared to its source
   before it reaches him. A failed check blocks the draft and posts a
   flag with both numbers, never a silent fix. UPDATE 2026-11-19
   (branch `feat/bot-auditor-2026-11-19`, DO-NOT-MERGE PR): the Auditor
   seat is wired — registry status live, group seat, group routing
   (name / Abel route / any-bot handoff / own turn on a draft landing;
   a bare keyword defers to Abel, who settles it in the room), code-only
   group checks (load math + windows, invoice vs agreed pay vs rate
   con, draft vs source field by field), all ten reasoning forms shared
   through `services/bots/reasoning.ts`, and no-write-path tests. The
   model-backed Auditor turn waits on a per-bot tool gateway (no such
   gateway exists yet — a model turn today would see Abel's write
   the reasoning adapter re-points at the shared engine
   when `feat/shared-reasoning-2026-11-19` lands. Migration 00103's
   seeded Auditor row still says 'planned' — flip it to 'live' when
   the migration is applied. (Update, 2026-11-20: the shared
   reasoning engine HAS landed — PR #101 merged to main 42b8127a —
   and this branch is rebased on it; the Auditor composes its scope
   overlay over the shared builder in auditor.ts, and the seeded-row
   flip is main-side bookkeeping.) Group chat is a team room
   (owner, 2026-11-19, correcting the earlier too-strict routing
   rule): bots talk to each other BY NAME in the room, ask each
   other for the source a check needs, flag drafts to their author,
   and only pull the owner in for a decision or approval; Abel is
   boss for what reaches the owner, not the only voice. INDIVIDUAL
   FACES (owner, 2026-11-19 — the one-face model was REJECTED): each
   bot its own Telegram account + profile photo, messaging as itself
   in the group. Bot-to-bot delivery, CORRECTED 2026-11-20 against
   Telegram's feature docs (the Bots FAQ states only the default):
   bots never see each other by default, but Bot-to-Bot
   Communication Mode (@BotFather /setbot2bot) is a real opt-in —
   command mentions and direct replies between bots are delivered
   when at least one bot of the pair has the mode on, and ordinary
   bot messages too when the receiving bot also has Group Privacy
   disabled (or is an admin). So the group IS the shared channel
   once the owner enables the mode per account; the handler already
   picks up a teammate's message addressed to the Auditor and runs
   its deterministic check (bounded: never a decision, never a
   model turn, check key absorbs repeats). Still owner-side steps:
   /setbot2bot ON + /setprivacy Disable (then re-add) or admin, per
   bot account. The Auditor's flags post through a per-bot send seam
   (`sendAsBot`, wired to TELEGRAM_AUDITOR_BOT_TOKEN when the owner
   provisions the account in BotFather); until then they fall back
   to the coordinator's face, same text. Still open for faces: the
   BotFather account + photo per bot (owner step), privacy mode OFF
   (BotFather /setprivacy + re-add) or admin per account so each bot
   sees the owner's ordinary group messages, and webhook fan-in so
   each bot account's updates reach this handler. Auditor checks are
   idempotent (deterministic check key in the audit log; a redelivery
   posts no second flag) and the Auditor is the single writer of
   auditor_check entries. No new framework was adopted in this
   branch — the open-source research (Mastra first choice, OpenAI
   Agents SDK simplest, LangGraph.js most durable; AutoGen archived,
   MetaGPT stale) is a decision for later, not a silent migration;
   the six patterns are applied now: supervisor-first routing (Abel
   coordinates, routedByBotSlug handoff seam), handoff as validated
   state (the check re-parses numbers from the stored proposal, not
   from a bot's summary), shared summaries not transcripts (checks
   read stored payloads), server-side enforcement (registry /
   guardrails + RLS), structural propose-only approval (deadlines,
   unanswered = denied), and Postgres claiming + idempotency keys
   (check_key + hasAuditorCheck, bounded reads).
5. Spending cap + model tiers in code: cheap model scans, stronger model
   ranks the best few only, hard cap that stops bot calls when hit and
   says so plainly.
6. Calling hook as a STUB only. UPDATE 2026-11-19: the Telnyx API key
   HAS since arrived (secure connector custom.telnyx) and the outbound
   voice profile ('Road to Legacy Outbound') was created + attached via
   the API — outbound calling is unlocked at the account level. UPDATE
   2026-11-19 (later): TELNYX_PUBLIC_KEY is set in Fly and the voice
   picks are made (Roger main, Bella for Billing). The stub stays a stub
   in this baseline anyway: the ElevenLabs integration secret + AI
   assistant connection are still open, and no live call happens
   without the owner's word. Real dialing is Phase 4.
7. Tests: guardrail tests (a bot cannot book/pay/message/sign), auditor
   math tests, tool-scope tests, group-routing tests. Gate: typecheck,
   lint, vitest, build on the exact tree.

Deliberately NOT in Phase 0: live load-board login (needs his board choice
+ credentials — DAT vs Truckstop undecided); calling (stub only); signature
use (pad empty); the remaining four seats (Tracker, Compliance Watchdog,
Maintenance, Billing) — their files exist, their wiring comes in Phase 2.

## Phase 1 — Dispatch Scout live (built 2026-11-19, branch `feat/dispatch-scout-boards-2026-11-19`)

- **Boards, ranked, free first:** TruLOS (no login at all), Trucker Path
  TruckLoads (free tier, no MC to start), JustTracking (free, no authority
  to start). The Scout walks them in that order and falls down the list
  when a board has nothing worth shortlisting. Paid boards (DAT,
  Truckstop, 123Loadboard) and broker apps (TruckSmarter, Uber Freight,
  Amazon Relay, C.H. Robinson, Loadsmart) join only when the owner
  subscribes / his own authority is active — they are listed, never
  read. There is no free public API for these boards.
- **Browser runtime (design: docs/bot-team-browser-runtime.md):** a
  SEPARATE always-on VM the bots share ("trucking-browser"), NOT a
  headless browser behind the Fly backend — the app machines auto-stop
  when idle, so no logged-in session survives there, and Chromium on a
  1 GB shared-cpu machine risks OOM. The VM owns the real browser
  session and the logged-in profile; the app talks to it over HTTP
  (`POST /read`, shared-secret header) at human pace (20s between
  reads, max 3 boards per run, 60s read timeout). Official API first
  wherever one exists. Credentials are Fly secrets only, never in the
  repo. Cost estimate in the design doc: ~$7–8/month (1 GB machine +
  small volume), labeled an estimate to confirm on Fly's pricing page;
  provisioning is a new recurring bill and needs the owner's word.
- **Live watch (owner requirement 2026-11-19):** the VM runs the browser
  under Xvfb and serves it via noVNC — the owner opens a watch link
  from his phone and sees the live browser (what board, what load, what
  is being clicked), with a STOP button and takeover of that same
  browser session. `watchUrl(runId)` / `stopRun(runId)` on the runtime
  client; the run id is a random per-run token, live only while the run
  is live plus a short grace.
- **24/7 always-on (settled 2026-11-19):** the same VM is the 24/7 home
  — scan schedule 30 min 6 AM–9 PM ET, hourly overnight; heartbeat
  every 5 min, flagged down in the group after 15 min of silence.
  Quiet hours 9 PM–6 AM ET: scanning continues, anything the owner
  would see holds until morning unless time-sensitive (pickup within
  6 hours). Never book/pay/sign/message a broker without the owner;
  the 00103 `bot_spend_ledger` $10/month cap gates every model call.
- **Shortlists of 3–5 loads** with rate, loaded + deadhead miles, $ per
  loaded mile, $ per ALL miles, broker credit/days-to-pay, pickup
  windows — judged on the round trip, exit priced (Florida warns in
  this cut). Propose-only: `bot_proposals` rows of kind
  "load-shortlist", Auditor-checked before the owner sees them.
- **Learn-from-every-load loop, first cut:** every load the scan looked
  at and did NOT shortlist lands in `bot_load_ledger` at scan time with
  outcome "skipped" and the plain-words reason; a denied shortlist
  writes its loads as skipped too. A shortlisted load gets its row when
  the owner decides (denied → skipped; approved → nothing yet, the
  "booked" row lands when the load is actually booked). `learnPreferences`
  reads the ledger (needs ≥3 booked loads before it suggests a floor) and
  never auto-applies anything.
- **Group wiring:** "scout, scan from <city, ST>" runs a scan; the Scout
  asks for the truck's origin and for any missing cost inputs (cost per
  mile, floor, diesel, mpg — from stored preferences or the message
  itself) instead of inventing them. The scan acks at once and posts the
  shortlist when it finishes.
- **Honest limits in this cut:** the browser VM does not exist yet, so
  no live board read has been performed and the read/watch/stop paths
  are unproven against a real worker. Deadhead comes from the board
  when the board gives it and from nowhere else — free boards usually
  do not, so those loads are unpriceable and skipped with the reason
  (deadhead via the app's routing is the next build). The app-side
  proposals route does not yet write ledger rows for a denied
  shortlist (only the group decision handler does). Registry status for
  dispatch-scout stays "planned" until the VM exists and a live read
  is proven.

### Bot identity (owner rules, 2026-11-19)

- **Abel is NOT Malik, and Scout is neither of them.** Malik is the
  name of the Telnyx AI assistant that calls on the shared number
  (+1 320-369-0102) in the Will voice. Abel is the owner's bot — his
  own name, his own voice (not picked yet; NOT Will, NOT Malik). Scout
  is his own bot with his own name: **Dispatch Scout**.
- **Scout's voice (recommended, needs the owner's approval): Brian**
  (ElevenLabs `nPczCjzI2devNBz1zQrb`, male, middle-aged, American) —
  a steady professional dispatcher voice for broker calls, clearly
  distinct from Malik's Will (young, relaxed optimist) and from
  whatever voice Abel gets. Alternate: Chris
  (`iP95p4xoKVk53GoZ742B`, male, middle-aged, American). Roger is NOT
  reused for Scout — it was Malik's first voice, and reusing it would
  blur the identities. No British or Australian voices (the owner
  wants American). The voice is recorded here only — per-bot voice
  wiring in code is not built yet; voices live at the Telnyx assistant
  level today.
- **Scout's photo:** isekai anime mixed with Jesus/faith imagery —
  radiant warm light, halo, hopeful anime look — the same style as all
  seven bot photos (a separate photo job is making them; Scout's photo
  just has to match). Scout's is distinct by color and symbol:
  **deep teal + a gold compass rose / map symbol**, so he reads as the
  load-finder at a glance. Abel currently just has the business logo —
  every bot gets its own image so the owner can tell them apart in the
  group chat.
- **Bots that never call need no voice:** Compliance Watchdog and
  Auditor show their info through the app / Telegram chat only.
  Billing gets Bella (female, `hpp4J3VqNfWAUOO0d1Us`) when that
  assistant is built. Tracker and Maintenance get their own distinct
  voices later, same rule — one voice per calling bot, never shared.

## Shared reasoning — one brain, every seat (built 2026-11-19, branch `feat/bot-shared-reasoning-2026-11-19`)

**Owner rule (2026-11-19): all bots get the same reasoning, wisdom,
and smartness Abel has — same brain, different jobs/tools; sharing the
reasoning must never leak another bot's tools.** This build is that
rule in code.

- **One source of truth for the forms.** Abel's reasoning-form rule
  blocks moved to a leaf module, `src/services/bot/reasoning-forms.ts`
  (no imports, so nothing can cycle). Abel's 1:1 prompt assembles them
  from there — byte-identical text, proven by his unchanged
  prompt-assembly test — and the team layer imports the SAME strings.
  A form edited once changes for Abel and every bot at once.
- **All fifteen forms, named, for every bot** —
  `src/services/bots/reasoning.ts` (`REASONING_FORMS` +
  `buildBotSystemPrompt(slug)`). The ten core forms (owner GO
  2026-11-10; temporal 2026-11-07): **temporal, contextual, causal,
  practical, self-correction, episodic, theory of mind, value
  learning, consolidation, restraint**. The five think-deeper forms
  (Frontier 1, owner GO 2026-11-11): **chained reasoning,
  self-verification, honest uncertainty, trade-off math, causal
  prediction**. No cut-down version for any seat. (PRACTICAL was
  extracted verbatim from inside TOOL_SELECTION_RULES so bots without
  dynamic tool selection still carry the form.)
- **Tools never leak.** Each bot's prompt names ONLY its own visible
  tool groups from the registry, with their scope levels, and states
  that unlisted groups do not exist for it. The registry/gateway half
  already hides the tools themselves; this is the prompt half of the
  same wall. Memory never leaks either: context is built from one
  bot's own `bot_team_memories` rows only.
- **Corrections-learning, shared** — `src/services/bots/learning.ts`.
  A correction is recorded per bot in Abel's own summary format
  ("corrected fields: …"); the counting is Abel's code
  (`correction-watchouts.ts`) fed through an adapter, not a copy. At
  2 corrections on the same field the bot earns a durable watch-out
  row in its own memory, and `buildBotMemoryContext` puts watch-outs
  first in its turn context. New store write path:
  `BotTeamStore.saveBotMemory` — no new migration (00103's
  `bot_team_memories` already carries kind correction/watch-out).
- **Wired live in this build:** Abel's group-chat turn now runs with
  the shared brain — `group.ts` passes `buildBotSystemPrompt("abel")`
  + his memory context through the webhook into `runBotChat`'s new
  optional `reasoningText` (appended to the system prompt only when
  present; the 1:1 paths are untouched — they carry the reasoning
  through the agent loop). Standing rules still travel as
  instructions; the rest of his memory renders in the context block.
- **Honest edges:** Scout's group paths are code-driven today (scan +
  dispatch workup), so Scout consumes `buildBotSystemPrompt` when his
  model turns land — the builder and tests are seat-complete now.
  `recordBotCorrection` is the write API for corrections; no group
  grammar parses free-text corrections yet (Phase 1). Abel's group
  turns still lack the live company snapshot (Phase 1 gap, unchanged).
  Mastra was NOT adopted in this lane (evaluated separately, per the
  owner's research rule); the patterns used are the ones already in
  the codebase — shared DB memory, propose-only guardrails, durable
  per-bot state in Supabase.

## Phase 2 — Remaining seats

Tracker (check-calls, ETA, BOL/POD), Compliance Watchdog (HOS/safety
alerts only, never edits a log), Maintenance (PM, inspections, work-order
drafts — owner approves every shop), Billing (drafter — invoices drafted
same day as delivery paperwork, sending gated by his approval). Each joins
the same group, same registry, same guardrails.

- **Maintenance is wired** (branch `feat/bot-maintenance-2026-11-19`,
  DO-NOT-MERGE PR, not merged, not deployed): registry scopes from its
  governing file, seated in the group, group routing (speaks only on
  clear routing — mention / reply / Abel-routed — or its own turn;
  keyword-only stays quiet and Abel routes via the `ROUTE: maintenance`
  handoff), DVIR defect intake, work-order drafts, shop call plans —
  all as proposals, all idempotent per Telegram message. All fourteen
  of Abel's reasoning forms, verbatim, through
  `src/services/bots/reasoning.ts` (interim — the shared-reasoning
  engine replaces that import when it lands). Individual faces: posts
  from its own Telegram token when configured, shared-token fallback
  with a text label until then. The six research patterns are applied
  (supervisor-first, validated-state handoffs, no transcripts,
  server-side enforcement, proposals as the structural HITL interrupt,
  single-writer, bounded loops, per-message idempotency); no framework
  adopted — Mastra is the first choice for a later migration
  evaluation. Still open after this branch: the scheduler/cron that
  posts due own-turns (the check + post functions exist and are
  tested; nothing calls them yet), live fleet-table reads for PM/DVIR
  state (the group has no company snapshot — the baseline's Phase 1
  gap), Maintenance's own 1:1 chat (no second bot token provisioned),
  and call/shop-message execution (Phase 1 / Phase 4).

### Team-room shape — the Telegram limit (verified 2026-11-19)

Telegram's own Bots FAQ (`core.telegram.org/bots/faq`): "bots will not
be able to see messages from other bots regardless of mode." The
"every bot hears every message" picture in this plan does not work as
stated on Telegram. The shape used — **INDIVIDUAL FACES (owner
decision 2026-11-19; the research report's one-face model was
rejected)**: each bot has its own Telegram account + profile photo
and messages as itself in the group. The server hears every owner
message and routes it to one bot's logic; bots coordinate internally
through Supabase (proposals, audit log, memories), never by seeing
each other's Telegram messages. The owner sees the team-room
behaviour; the plumbing is individual accounts + shared state.
What blocks full individual-face operation: only Abel's bot token
exists today — each other bot's token is provisioned by the owner in
BotFather (account + profile photo + `TELEGRAM_<BOT>_BOT_TOKEN` Fly
secret) and its webhook registered; until then that bot falls back to
the shared token with a "Name: " text label
(`src/services/bots/sending.ts`, wired for Maintenance in
`src/services/bots/group.ts`). Setup the owner must do in BotFather
for the group to work at all: Privacy Mode OFF for each bot (or make
it a group admin) — with privacy mode ON the bot only receives
addressed commands and replies, and plain owner messages never reach
the handler. Re-add the bot to the group after changing the setting.
Alternative for later, owner decision, NOT built: Forum Topics —
one topic per agent in a supergroup.

### Frameworks — no new framework adopted (2026-11-19)

Open-source multi-agent research
(`research_notes/open-source-multi-agent-team-20261119-2022/report.md`)
recommends Mastra first (TS-first agents + typed durable workflows +
suspend/resume human-in-the-loop + `@mastra/pg`, Apache-2.0 core),
OpenAI Agents SDK (TypeScript) simplest (handoffs first-class, MIT),
LangGraph.js most durable but steepest. None is adopted in the bot
builds: five crews are building in parallel on the baseline's plain-TS
supervisor / router / guardrails / store, which already carries the
patterns that matter (supervisor-first routing, handoff = validated
state only, shared state not transcripts, server-side enforcement via
RLS + code, proposals as the structural human-in-the-loop interrupt,
single-writer proposals, bounded loops, per-message idempotency).
Adopting Mastra (or another framework) is a separate migration
decision for the owner, after the five seats land — not a silent
change inside a bot branch. Avoid: Microsoft AutoGen (archived Oct
2026), MetaGPT (stale since early 2026). No open-source project was
found running a small business end-to-end in Telegram — borrow the
patterns, not a whole project.
### Phase 2 shape — the group IS the channel (owner rule 2026-11-19)

The group chat is a team room and the shared channel: everything the
owner posts there lands for all the bots, and when Abel needs Tracker,
Abel posts the message in the group chat too, addressed to Tracker, and
Tracker picks it up there. The messages live in the room where everyone
can see them — not a database-only relay the owner never sees.

Each bot is its own Telegram account with its own profile photo
(individual faces — the owner rejected the one-face model). The face
registry is `src/services/bots/faces.ts` (slug, display name, BotFather
username, photo reference, token env var name, webhook path — never a
token value).

Telegram mechanics, verified 2026-11-19 against Telegram's own docs
(core.telegram.org/api/bots/bot-to-bot, /bots/faq): Bot-to-Bot
Communication Mode (Bot API 9.6, April 2026) must be enabled for every
bot in @BotFather, and Group Privacy Mode disabled (or group admin), or
bots do not see each other's messages at all — that is the default. With
the mode on, a bot receives another bot's message when mentioned by
command (`/command@TargetBot`) or in direct reply (at least one of the
two bots needs the mode on); as admin or privacy-disabled it also
receives other bots' messages without a mention or reply. Go-live
checklist per bot (manual @BotFather steps, no API flips them): create
the bot, enable Bot-to-Bot Communication Mode, disable Group Privacy
Mode (or make it a group admin), re-add it to the group after any
privacy change, put its token in a Fly secret named in `faces.ts`.
Until the mode is on for a bot, bot-to-bot delivery falls back to the
handoff queue (`bot_handoffs`) with the room post still visible to the
owner. Loop guards are in code: a bot answers another bot only when
addressed by name or in reply, never its own chatter, never unprompted;
handoff chains depth-capped at 3; the group-message log dedupes by
Telegram message id.

Per-bot webhooks are the activation step not yet built: each bot's
webhook calls the group handler with its own `faceBotSlug`, and the
deterministic router decides once — only the face the message routes to
acts (the face gate in `services/bots/group.ts`), and only Abel's face
handles owner decisions ("yes"/"no"). Without a `faceBotSlug` the
handler behaves as in the single-bot deployment: it acts on every
routed message.

### Research patterns applied in the Tracker build (2026-11-19)

Source: `~/workspace/research_notes/open-source-multi-agent-team-20261119-2022/report.md`.
No new framework adopted — Mastra is the first choice if the
shared-backend crew adopts one later, OpenAI Agents SDK (TS) the
simplest, LangGraph.js the most durable and steepest; AutoGen (archived
Oct 2026) and MetaGPT (stale since early 2026) avoided. The patterns
below are applied in code, not as a future note:

- Supervisor-first: one deterministic router (`services/bots/router.ts`);
  Abel is the boss for what needs the owner's attention, and owner
  decisions are handled only by Abel's face (`services/bots/group.ts`).
  Tracker falls through to Abel when it has nothing to add.
- Handoff payload = validated state only: `buildHandoffPayload` in
  `services/bots/tracker.ts` carries loadRef, objective, then — never
  a transcript; `bot_handoffs` rows are the work items.
- Shared state/summaries, not full transcripts: group turns pass the
  system prompt + memories + one handoff summary line with `history: []`
  (`services/bots/group.ts` `handleTrackerTurn`).
- One model router + per-agent scoped tools: `router.ts` + the scope
  table in `services/bots/registry.ts` (Tracker: loads read-write, HOS
  read, money none, documents read-write, email read-write, maps read,
  app-actions read-write, calls gated, signature never).
- Server-side enforcement via Supabase RLS, not prompts:
  migration `00105_bot_tracker.sql` (RLS on `bot_check_calls`,
  `bot_detention_clocks`, `bot_doc_packets`, `bot_handoffs`) plus code
  enforcement in `services/bots/guardrails.ts`; prompts are
  defense-in-depth only.
- Human-in-the-loop as a structural interrupt/suspend: proposals are
  rows with a yes/no grammar, a live-deadline check, and a guardrail
  refusal even with approval while no execution path exists
  (`services/bots/group.ts`, `guardrails.ts`).
- Single-writer ownership per thread/job: `claimHandoff` (only the
  named bot, only while open) and the face gate (only the routed face
  acts) in `services/bots/group.ts`; `decideProposal` is idempotent.
- Postgres job claiming + idempotency keys + bounded loops:
  `bot_handoffs` claiming + idempotency key in `services/bots/store.ts`,
  `MAX_HANDOFF_DEPTH = 3` in `services/bots/tracker.ts`.

**Compliance Watchdog — BUILT 2026-11-19, branch
`feat/bot-compliance-watchdog-2026-11-19`, DO-NOT-MERGE PR, NOT merged,
NOT deployed.** `src/services/bots/compliance-watchdog.ts` (deadline
checklist evaluation, red/amber alerts, load-legality verdict, HOS
coverage flags, reminder proposals, document-copy filing, handoffs),
shared reasoning via the team's engine (PR #101: `REASONING_FORMS` +
`sharedReasoningPrompt()` in `src/services/bots/reasoning.ts`, forms
sourced from `src/services/bot/reasoning-forms.ts` — Watchdog's turn
carries all fifteen forms, the owner's ten core included, one brain,
not a cut-down version), migration `00106_bot_team_watchdog.sql`
AUTHORED, NOT applied (`bot_compliance_deadlines` + the Watchdog
scope correction), group seat wired (router + group turn + spend cap),
Scout workups carry the Watchdog block, sweep route
`POST /api/bots/compliance-watchdog/sweep` (job-claimed; idempotent
amber dedupe; red always posts). Governing files
`docs/bots/compliance-watchdog/` (byte-identical to the owner's copies).

**TEAM ROOM (owner's model, 2026-11-19 — built into Watchdog): the
group chat IS the shared channel.** Everything posted in the room
lands for all the bots; when Abel needs Watchdog he posts in the
group addressed to Watchdog, and Watchdog picks it up there.
Watchdog talks to its teammates BY NAME in the room, asks for work
it needs, hands work off, and reports progress out loud:
- The sweep posts Dispatch Scout a compliance HOLD by name the
  moment the checklist blocks (and the heads-up version when it
  cannot confirm) — before a load is offered, not after.
- The sweep asks Tracker by name for the truck's current position
  when a dated deadline is close and the truck is out running.
- Scout workups carry Watchdog's legality verdict in the room, and
  a block records a structured handoff to Scout.
- Watchdog's group turn reads the handoffs the team left for it
  (summaries, newest first) and picks them up in its reply.
- Bots never decide proposals — a bot's "yes" in the room is
  conversation; only the owner approves.
The receiving side is `src/services/bots/bot-channel.ts`: a bot
sender is identified by its registered Telegram username, its
message is deduped by message id, routed by the same router the
owner's messages use, and answered only when addressed to a seated
bot under the chain cap (below).

**FACES (owner, 2026-11-19): each bot its own Telegram account +
profile photo, messaging as itself — the one-face model was rejected.**
Telegram mechanics — VERIFIED 2026-11-19 against Telegram's Bot
Features documentation (core.telegram.org/bots/features,
"Bot-to-Bot Communication"), which supersedes the older absolute
line in the Bots FAQ: (1) a bot receives another bot's group message
when ADDRESSED to it (mention in a command, or a direct reply) if at
least one of the pair has **Bot-to-Bot Communication Mode** enabled
in @BotFather (/setbot2bot); (2) a bot with that mode enabled
receives ALL bot messages in the group when it is a group **admin**
or has **Group Privacy Mode disabled**; (3) the owner's messages
reach every bot with privacy OFF (set before joining, or remove +
re-add the bot after changing it) or admin rights; (4) Telegram
REQUIRES loop safeguards with bot-to-bot on — dedupe, rate limits,
maximum interaction depth. Nothing in Telegram blocks individual
faces or the group-as-channel model; the settings above are the
whole requirement, per bot: own BotFather account + photo,
Bot-to-Bot Communication Mode ON, Group Privacy OFF, added to the
group. APP SIDE, built here: Watchdog sends AS ITSELF the moment
`TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN` is set (sweep route +
group-turn `sendMessageAs`; no name prefix), and falls back to the
shared token with its name prefix until then. The bot-channel
receiving logic is wired and tested now; it activates per bot as
each bot's own webhook lands (Telegram delivers each bot's updates
to its own webhook — with one shared webhook today, bot-authored
updates cannot arrive yet; the structured handoff records carry the
same work inside the backend meanwhile, and every handoff is ALSO
posted in the room — never a database-only relay the owner can't
see). PRECEDENT (owner, 2026-11-19 ~2:35 PM CT): Scout already has
its own BotFather account (@DispatchScoutBot, verified live) and
its token is set in Fly as TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN (the
value is NOT saved anywhere); Scout's send-as-himself wiring is
deliberately NOT flipped in this branch — his group membership and
privacy steps are the owner's to finish, and sending as a bot that
is not in the group would fail where the prefixed send works.
Watchdog's remaining owner step: its BotFather account + photo +
token in Fly under TELEGRAM_COMPLIANCE_WATCHDOG_BOT_TOKEN, privacy
OFF + bot-to-bot ON, added to the "Road to Legacy Crew" group.
Forum Topics were evaluated as an alternative shape and not used:
topics organize threads inside one chat but change none of the
delivery rules above, and the owner's model is one shared room.

**RESEARCH APPLIED, pattern by pattern (owner: "use them NOW",
2026-11-19; source `~/workspace/research_notes/open-source-multi-agent-team-20261119-2022/report.md`):**
- *Supervisor-first routing* — `bots/router.ts`: every room message
  routes to exactly one seat; Abel is the default/coordinator.
- *Handoff payload = validated state only* — `recordHandoff`
  (compliance-watchdog.ts): {to, reason, ref, deadlineKind,
  fingerprint} in the audit log; no free-text state transfers.
- *Shared state/summaries, not full transcripts* — the compliance
  snapshot and handoff summaries in Watchdog's turn
  (`buildWatchdogInstructions`); the room log stores messages, the
  turns read summaries.
- *One model router + per-agent scoped tools* — the shared
  `runBotChat` path + `bots/reasoning.ts` `buildBotSystemPrompt`
  scope framing; Watchdog's registry scope (documents read-write,
  email draft, money none, calls never) enforced by
  `bots/guardrails.ts`.
- *Server-side enforcement via Supabase RLS, not prompts* —
  migration 00105: `bot_compliance_deadlines` RLS by `company_id` +
  company-read policy; every store read/write is company-scoped in
  code as well.
- *Human-in-the-loop as a structural interrupt* — proposals decide
  only on the owner's yes/no in the handler code; bot senders are
  structurally barred from the decision grammar (group.ts).
- *Single-writer ownership* — only Watchdog writes its checklist
  rows (`upsertComplianceDeadline`, one writer per kind + subject);
  only the claimed sweep posts its alerts.
- *Postgres job claiming + idempotency keys + bounded loops* —
  sweep claims (`sweep_claim` audit rows, 15-minute window,
  retries are no-ops), alert + handoff fingerprints (amber 24h,
  team posts once per Eastern day per state, max two per sweep),
  and the bot-channel chain cap (4 consecutive bot messages, reset
  by a human post) with message-id dedupe.
Mastra is the first-pick framework evaluation with a recommendation
in the PR — NOT adopted silently, NOT a dependency here. Avoid:
Microsoft AutoGen (archived Oct 2026), MetaGPT (stale since early
2026). No end-to-end small-business Telegram example exists in the
open — patterns borrowed, not a whole project.

## Phase 3 — Animated in-app room (LATER — owner decision 2026-11-19)

**Do NOT build in the baseline. Telegram first; the animated room second,
after the Telegram backend works. Same backend behind both.**

Each bot gets its own animated caricature face — moves, eyes, like the Grok
bot — inside the app, in a group room that shows the same conversation the
Telegram group shows. The faces are PRESENTATION ONLY: they never change a
bot's rules, tools, or guardrails; a face never acts, never sends, never
approves; a face never sees data beyond what that bot's role already sees.
The room is a second front door on the same backend, not a second brain.

Open questions for Phase 3 (owner's call, when we get there): face art
style per bot, which app screen hosts the room, animation budget on phones
(cheap transforms/opacity only), and whether the room replaces Telegram or
runs alongside it.

## Phase 4 — Calling live

Telnyx outbound voice profile + number attached + ElevenLabs voice
connected, then ONE test call to his phone only, on his word. Bots that
need to call use the shared number in his voice, take turns, log every
call, Auditor spot-checks calls. UPDATE 2026-11-19: the API key arrived
(secure connector custom.telnyx) and the outbound profile ('Road to
Legacy Outbound') was created + attached via the API — outbound calling
is unlocked at the account level, bypassing the portal's "not permitted"
block. UPDATE 2026-11-19 (later): TELNYX_PUBLIC_KEY is now set in Fly
(fetched via the API), and the voice picks are made — main calling voice
Roger (male, American), Billing bot Bella (female) when that assistant is
built. Still open: the ElevenLabs key as a Telnyx integration secret
(BLOCKER — no integration secret exists yet), then the AI assistant
creation (TELNYX_ASSISTANT_ID) + the test call, only on his word. Two
similar profiles now exist — do not delete either without asking him. The
API shows call forwarding disabled on the number despite his portal 'on
failure' setting — verify in the portal.

## What is NOT in this plan

- CoinRuler is NOT in the dispatch group (crypto only, separate account).
- Soumaya is NOT in dispatch (second brain, info only).
- No second driver, no hiring, no recruiting until he has the trucks.
- No auto-booking, auto-pay, auto-sign, auto-file — ever, without a new
  explicit owner decision per action.
