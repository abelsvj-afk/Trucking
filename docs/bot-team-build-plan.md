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
   flag with both numbers, never a silent fix.
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
