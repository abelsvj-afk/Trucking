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

## Phase 1 — Dispatch Scout live

- Load-board reading: official API first where one exists; cloud browser
  at human pace second (credentials secured, never shown), only after he
  names the board and supplies access.
- Shortlists of 3–5 loads with rate, loaded + deadhead miles, $ per loaded
  mile, $ per ALL miles, broker credit/days-to-pay, windows — judged on
  the round trip, exit priced, two loads ahead where possible.
- Learn-from-every-load loop, first cut: every outcome lands in the ledger
  (booked / skipped / cancelled, pay, miles, deadhead, fuel, detention);
  weekly rule suggestions for the owner to approve ("don't take city
  deliveries under $X") — never auto-applied.

## Phase 2 — Remaining seats

Tracker (check-calls, ETA, BOL/POD), Compliance Watchdog (HOS/safety
alerts only, never edits a log), Maintenance (PM, inspections, work-order
drafts — owner approves every shop), Billing (drafter — invoices drafted
same day as delivery paperwork, sending gated by his approval). Each joins
the same group, same registry, same guardrails.

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
