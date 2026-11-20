# Bot team — Billing

Billing turns a delivered load into money. When a load is delivered and
the POD is signed, it drafts the invoice the same day (rate confirmation
+ POD in one packet), posts "invoice ready" in the group chat with the
amount and the broker, tracks paid/unpaid invoices and flags overdue
ones, flags a short-pay or deduction with evidence, and hands the owner
a clean packet for factoring when he asks. Its voice is Bella
(ElevenLabs `hpp4J3VqNfWAUOO0d1Us`). It never sends an invoice or a
factoring packet without the owner's approval, never records a payment
without evidence, never moves money, and never finalises a settlement
or payroll.

Governing files: `~/workspace/goals/own-truck-own-authority-my-own-trucking-company/bots/billing/`
(`CLAUDE.md`, `SOUL.md`, `MEMORY.md`) — also on PR #95 under `docs/bots/`.

## Files in this change

| File | What it is |
| --- | --- |
| `src/services/bots/billing.ts` | Billing's brain: invoice math, audit, speak/quiet decision, handoffs, group turn, instructions. |
| `src/services/bots/faces.ts` | Per-bot Telegram faces: identity shape, BotFather setup checklist, room-speaker attribution, live `getMe` settings check. |
| `src/services/bots/reasoning.ts` | Shared reasoning engine home: all 15 reasoning forms, built per-bot from a `ReasoningBotContext` so no other bot's tools leak in. |
| `src/services/bots/registry.ts` | Billing's scoped tools (money read→draft, documents read→draft, email read→read-write with send execute-gated; loads read; HOS/maps none; calls gated; signature never). Status `planned`. `GROUP_SEATS` now `["abel", "dispatch-scout", "billing"]`. |
| `src/services/bots/router.ts` | Billing mentions checked before Dispatch Scout's "broker"; billing keywords (invoice, factoring, short-pay, overdue, deduction, unpaid, who owes) first. Bare "paid" stays with Abel (paycheck question). Tracker POD/BOL/ETA before Scout's generic "load". |
| `src/services/bots/group.ts` | Group handler: Billing branch, bot-to-bot branch, claim-once dedupe, bot-speech room log, Abel→Billing fan-out (flag-gated bridge). |
| `src/services/bots/store.ts` | `ProposalKind` + `invoice-draft` / `factoring-packet`; `findGroupMessage` (reply attribution); `botTeamServiceClient` for Billing's read store. |
| `src/app/api/telegram/webhook/route.ts` | Per-bot webhook: `?bot=<slug>` picks the face's token; unknown slug is a 400; no `?bot=` means Abel's webhook. |
| `supabase/migrations/00107_bot_billing.sql` | Extends the `bot_proposals` kind check with `invoice-draft` and `factoring-packet`. **Authored only — NOT applied.** Live apply is the owner's tap via King's lane, same rule as migration 00103. (Renumbered in the 2026-11-19 merge lane: authored as 00105, lands as 00107 in landing order after Scout 00105 and Watchdog 00106.) |
| `tests/unit/services/bots/{billing,faces,reasoning,group,router,registry}.test.ts` | See "Gate" below. |

No new invoice table: `load_invoices` already exists (migration
`00055_gap_invoices.sql`, one live invoice per load, RLS by
`company_id`). Billing writes no `load_invoices` rows in this build —
drafts live as proposals; creating the row and sending is Phase 1
execution behind an approved proposal.

## Reasoning — all of it, none cut down

Owner order 2026-11-19: Billing gets ALL of Abel's reasoning forms
through the shared engine — one shared brain, not a cut-down version.
Only its job, its scoped tools, and its memory stay individual.

- **All ten canonical forms** (`reasoning.ts`): temporal, contextual,
  causal, practical, self-correction, episodic, theory-of-mind
  (first-order), value-learning, consolidation, restraint — plus the
  five extended Frontier-1 forms: chained, verification, uncertainty,
  tradeoff, prediction. All 15 are built for Billing
  (`reasoningInstructionsFor("billing")`) and wired into
  `billingInstructions()`. **No form was dropped.** None of the ten
  genuinely fails to apply to Billing's job: temporal (due dates,
  overdue), contextual (broker terms, load context), causal (why a
  payment is short), practical (what to do today), self-correction
  (audit flags), episodic (past invoices/payments), theory-of-mind
  (what the broker/owner needs to hear), value-learning (what the
  owner approved), consolidation (invoice records as memory),
  restraint (never send, never move money).
- **Deliberately NOT included:** outcome-learning
  (corrections-learning) and fleet/driver content — those are owned by
  the shared-reasoning crew and by Abel's job content respectively,
  not reasoning forms. The shared-reasoning crew owns unifying Abel's
  own rendering (`agent-turn.ts`) onto this module; see "Rebase notes".

## How Billing decides when to speak (team room)

`billingShouldSpeak(route, opts)` in `billing.ts`:

| Situation | Decision |
| --- | --- |
| Called by name ("Billing, …") | Speak |
| Routed by Abel | Speak |
| Own turn (invoice ready, payment overdue, short-pay needing a decision) | Speak |
| Handoff from another bot, addressed to Billing | Speak (answers the bot by name) |
| Concrete money fact to add to another bot's work (exactly one delivered load waiting on an invoice after a POD/delivery notice) | One short note, then quiet |
| Another bot's job, or unclear whose it is | Quiet — Abel routes it |
| Unseated bot's job (e.g. Tracker not in the room yet) | Abel's "isn't in the room yet" reply + at most one Billing note |

In Billing's own 1:1 chat this decision does not run — there it
handles its own job directly.

## Handoffs — by name, validated state only

- **Ask Tracker** for the signed POD (`billingNeedsPodAsk`); **ask
  Dispatch Scout** for the rate confirmation
  (`billingNeedsRateConAsk`). A blocked draft reports what is missing
  and who holds it, and records a durable `handoff_requested` audit
  row (load, need, who holds it) so the next bot's turn can pick it
  up from shared state.
- **RoomHandoff** (`billing.ts`): `{ from, to: "billing", kind,
  loadId, loadRef, summary }` — kind is one of `pod-ready`,
  `rate-con-ready`, `invoice-asked`, `general`; the load is matched
  in code against delivered loads waiting on an invoice; the summary
  is one line (≤240 chars) written from the matched record, never
  raw chat text. The model turn receives the summary as one
  instruction — never a transcript.
- A **pod-ready handoff names the load**: it drafts the invoice
  directly (same-day rule) without waiting for someone to say
  "invoice it" in words.

## The group IS the shared channel — Telegram mechanics, verified

Verified against Telegram's own docs on 2026-11-19
(`core.telegram.org/api/bots/bot-to-bot`, Bot API 9.6):

- **Bot-to-Bot Communication Mode ON** in @BotFather (`/mybots` →
  Bot Settings → Bot-to-Bot Communication Mode → ON) for every bot
  that participates.
- **Group Privacy OFF** in @BotFather (or the bot is a group admin).
  A privacy change applies only after the bot is **removed and
  re-added** to the group.
- Then, in a group, a bot receives another bot's message when it
  contains a command mention addressed to it (`/command@TargetBot`),
  when it is a direct reply to one of its messages, and — with the
  mode on AND admin / privacy-off — **all** of the other bots'
  messages, with no mention or reply needed. At least one of the two
  bots must have the mode on.
- Every bot with privacy off also receives **every message the owner
  posts**: the group is the shared channel, and the owner's words land
  for all the bots. When Abel needs Billing, Abel posts in the room
  addressed to Billing, and Billing picks it up there — that is the
  purpose of the group, and the messages live in the room where
  everyone can see them.

**The FAQ conflict, stated plainly:** the Bots FAQ still says "bots
will not be able to see messages from other bots regardless of mode".
That is the pre-9.6 rule. The dedicated bot-to-bot page (Bot API 9.6,
April 3, 2026) supersedes it, and the telegram-multi-agent project
and a Bot-to-Bot debate-club demo corroborate it in practice. This
build was **not live-tested end to end** — no Billing account exists
yet — so the code is built to work when the settings are on and to
fail safe (ignore) when they are off. The live test is an owner step
(see below).

**Individual faces — the target shape, not one-face:** each bot gets
its own Telegram account (own BotFather token, own profile photo) and
messages as itself. `faces.ts` carries the shape: token env var per
bot (`TELEGRAM_<BOT>_BOT_TOKEN`), username (null until the owner
creates the account — no username is invented), photo status, the
setup checklist, and a live `getMe` check
(`fetchBotFaceStatus`) that reports `can_read_all_group_messages`
(i.e. whether Group Privacy is really off). The webhook routes by
`?bot=<slug>`; replies go out under the receiving face's token.
Nothing blocks individual faces — the only requirements are the two
BotFather settings above, the per-bot webhook URL, and the Fly secret
per token. Scout is already real: `@DispatchScoutBot`,
`TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN` live in Fly with v115; his steps
are `/setprivacy Disable` + adding him to the "Road to Legacy Crew"
group.

**Until Billing's own account exists** (bridge, flag-gated): Abel's
reply naming Billing also runs Billing's turn in-process once
(`group.ts` fan-out, `billingSeparateWebhookLive` false). Once
Billing's webhook is live (`TELEGRAM_BILLING_WEBHOOK_LIVE=true` in
Fly), Telegram delivers Abel's post to Billing's webhook and the
fan-out stays off — otherwise Billing would answer twice.

**Loop prevention (Telegram's own warning):** one webhook update is
claimed exactly once (room-log unique key — the first of the seven
webhooks to insert the incoming message wins, the rest see the
duplicate key and stand down, so the room answers once); one update
produces at most one routed answer plus at most one Billing note;
Billing's turn never invokes another bot's turn in-process except the
single Abel→Billing fan-out; depth is bounded at two bot turns per
owner update by construction. Bot speech is logged in the room record
(`bot_group_messages`) so a reply to one of Billing's messages is
addressed to Billing even when the reply text never names it.

## Research patterns — applied NOW, in this build

From `~/workspace/research_notes/open-source-multi-agent-team-20261119-2022/report.md`
(owner order 2026-11-19: use the research now, not later). Each
pattern, where it lives in code:

| Pattern | Where it is applied |
| --- | --- |
| Supervisor-first routing | `router.ts` is the single routing authority; Abel is the boss for what needs the owner's attention (`billingShouldSpeak` abelRouted case; unseated → Abel). |
| Handoff payload = validated state only | `RoomHandoff` (`billing.ts`): kind + load id + one summary line, built in code from matched records. `handoff_requested` audit rows carry load + need + holder only. |
| Shared state/summaries, not full transcripts | Model turns get `history: []` + stored memories + at most one handoff summary line (`billing.ts` group turn). The room log is the blackboard; turns never ingest a transcript. |
| One model router + per-agent scoped tools | One `runChat` provider for every bot; Billing's instructions list only its own tools; `registry.ts` scopes are the enforcement surface. |
| Server-side enforcement via Supabase RLS (not prompts) | `load_invoices` RLS (00055), `bot_*` RLS (00103), `company_id` filter on every Billing data query, `guardrails.ts` `checkBotAction` in code before drafting, execute-class refused in code. Prompts describe the limits; the code enforces them. |
| Human-in-the-loop as a structural interrupt/suspend (not a prompt) | The proposal row IS the suspended state (cf. Mastra `suspend()` / LangGraph `interrupt()`): an invoice-draft/factoring-packet proposal waits on the owner's plain-words yes/no; resume is the decision; there is no execution path at all until Phase 1. `PROPOSAL_EXPIRY_MS` bounds the wait. |
| Single-writer ownership per thread/job | One live invoice per load (unique index, 00055); one open `invoice-draft` proposal per load and one open `factoring-packet` per invoice (`findOpenProposalForLoad`, `billing.ts`) — the first writer wins, later asks point at the open proposal. |
| Postgres job claiming + idempotency keys | The room-log unique key claims each incoming group message exactly once across all seven webhooks (`claimRoomMessage`, `group.ts`); `sourceRef = telegram-group:<load-id>` is the proposal idempotency key (`findOpenProposalForLoad`). |
| Bounded loops | One update → at most one routed answer + at most one Billing note + at most one fan-out turn; no chained in-process bot turns; spend cap in front of every model call; Telegram's own 20 messages/minute/group per bot applies on top. |

**Frameworks — evaluated, not adopted.** Mastra is the first choice
for this stack (TS-first agents, typed durable workflows,
suspend/resume human-in-the-loop, PostgresStore via `@mastra/pg`,
Apache-2.0 core) and the recommendation for a later evaluation;
OpenAI Agents SDK (TypeScript) is the simplest (handoffs first-class,
MIT); LangGraph.js is the most durable but steepest. **No new
framework was added in this PR** — the existing backend already
implements the patterns above in code, and adopting a framework
silently would break the owner's rule. Avoided: Microsoft AutoGen
(archived Oct 2026), MetaGPT (stale since early 2026). Honest
finding from the research: no open-source project was found running
a small business end-to-end in Telegram — patterns were borrowed,
not a whole project.

## What still needs the owner

1. Create Billing's Telegram account in @BotFather; set the token
   in Fly as `TELEGRAM_BILLING_BOT_TOKEN` (never in the repo or
   chat); set its profile photo.
2. For Billing (and every bot): Bot-to-Bot Communication Mode ON,
   Group Privacy OFF, remove and re-add to the "Road to Legacy Crew"
   group, webhook to `/api/telegram/webhook?bot=billing`.
3. Set `TELEGRAM_BILLING_WEBHOOK_LIVE=true` in Fly once step 2 is
   done (turns the Abel→Billing fan-out bridge off).
4. Set `TELEGRAM_GROUP_CHAT_ID` to the group's chat id once the
   group exists (without it, groups are ignored).
5. Send one test message in the group and confirm Billing answers
   as Billing — including an Abel→Billing handoff ("Billing, draft
   the invoice…") picked up in the room.
6. Migration 00105: apply live on his tap via King's lane.
7. Deploy: his separate tap. No merge, no deploy from this PR.

## Rebase notes

- **Main moved during this build:** branch cut from `9e442fdb`
  (PR #96), rebased onto `87dc7ce6` (PR #98, Malik tools, merged
  2026-11-19; live as Fly v115), then main was merged in twice more
  (`7789bc9` — Scout PR #97 + map fixes; `d120331` — UI polish).
  The gate ran on the final union tree (see "Gate").
- **Shared reasoning** (`feat/shared-reasoning-2026-11-19`): still in
  flight at last check (local only, not pushed); merges when
  gate-clean and verified (MERGE-WHEN-READY). **DUPLICATION FLAG:**
  that branch carries its OWN `src/services/bots/reasoning.ts`
  (verbatim-from-Abel blocks, different API:
  `buildBotSystemPrompt` / `SHARED_REASONING_TEXT`), and this branch
  carries a parallel rewrite (bot-neutral, `reasoningInstructionsFor`).
  Both cover all ten canonical forms + the five extended ones — there
  must be ONE shared engine. When shared-reasoning merges, its version
  wins (verbatim Abel blocks, prompt-presence tests pin Abel's
  behavior unchanged), this branch's `reasoning.ts` is DELETED, and
  `billing.ts` / `billingInstructions()` are re-pointed at the shared
  API. Until then Billing reasons through this branch's copy — all 15
  forms, none cut down. Rebase flag: if their merge changes
  `reasoning.ts` or `billingInstructions()`, re-run the reasoning
  tests and the Billing group-turn tests.
- **Faces** (`src/services/bots/faces.ts`): **DUPLICATION FLAG:** the
  Tracker crew (`wt-bot-tracker-2026-11-19`) wrote its own `faces.ts`
  in parallel — same `BOT_FACES` registry idea, different API
  (`faceFor` / `slugForUsername` vs this branch's `botFace` /
  `resolveBotFace` / `fetchBotFaceStatus` / `parseRoomSpeaker`).
  Whichever PR lands second must unify the two into ONE `faces.ts`
  (this branch's is fuller on setup + live checks; Tracker's adds the
  username→slug mapping Billing lacks) instead of landing a second
  copy. No bot's face is blocked either way — the requirements are
  the two BotFather settings, the per-bot webhook URL, and the Fly
  secret per token.
- **Scout** (PR #97) has MERGED to main: `dispatch-scout.ts` and
  its tests are on main, and the union needed one stub fix (see
  "Gate" item 6). Scout's token is live in Fly. `GROUP_SEATS` /
  `router.ts` are touched by several bot crews — re-check seat
  order after each merge.
- **Proactive triggers still Phase 2:** the delivery/POD event hook
  or daily cron that posts "invoice ready" / overdue / short-pay
  without being asked, and the full in-process job runner invoking
  Billing's turn when Tracker posts a POD outside the group flow.

## Gate

Run on the final union tree (branch tip after the merges of main
`7789bc9` and `d120331`; see "Rebase notes"). Persisted logs:
`~/workspace/builds/billing-build-final.log` (build) plus the
replacement crew's session logs.

- **Typecheck** (`tsc --noEmit`, fresh `tsconfig.tsbuildinfo`
  deleted first): **exit 0**.
- **Lint** (`eslint` on `src/services/bots/**`,
  `src/app/api/telegram/webhook/route.ts`,
  `tests/unit/services/bots/**`): **exit 0**. Full-repo `eslint .`
  was attempted three times and killed each time by daemon
  restarts / OOM from parallel crews' builds before completing —
  the scoped run covers every file this branch touches.
- **Targeted vitest** (cold caches, `--pool=threads`):
  `tests/unit/services/bots/` + the two telegram webhook test
  files — **18 files, 201 tests, all passed**. (The full suite was
  not run; the assignment's gate is the targeted set. The known
  `store-company-scope` timeout flake lives on main and is
  untouched by this diff.)
- **Build** (`next build`): **exit 0** — compiled successfully,
  TypeScript phase passed, static pages 157/157.

What the gate caught and fixed on this branch:

1. **Router:** `/\bshort.pay\b/` never matches "short-paid"
   (p-a-y ≠ p-a-i-d) — a short-pay routed to Dispatch Scout. Now
   `/\bshort[-\s]?paid?\b/` in mentions + keywords.
2. **`billingShouldSpeak`:** Abel routing a job to Billing now
   speaks (`routed-by-abel`) even when the router named another
   seat.
3. **Instructions wording:** hard limits now use the governing
   file's own words ("Never send an invoice or a factoring packet
   without the owner's approval.").
4. **Handoff test scenario:** a pod-ready handoff auto-drafts by
   design (same-day rule; the group tests cover it), so the
   model-turn handoff test exercises a rate-con-ready handoff.
5. **`group.test.ts` was one brace short** — the fan-out test "no
   fan-out once Billing's own webhook is live" had lost its
   closing `});` in the first crew's work (write flap / truncation
   before their session died). It slipped past two checks on stale
   caches (`tsconfig.tsbuildinfo`, vitest transform cache); the
   production build's fresh type-check caught it (TS1005 at EOF).
   Repaired with the single missing line; parse diagnostics 0.
6. **Union-tree stub:** main's Scout tests (PR #97) stub
   `BotTeamStore` without `findGroupMessage` (added by this
   branch for reply attribution) — stub added, returns null.
