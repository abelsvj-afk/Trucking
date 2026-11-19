# Bot team shared reasoning — design + audit

Owner order, 2026-11-19 voice call: **all bots get the same form of
reasoning, wisdom, and smartness Abel has — same brain, different
jobs/tools.** Sharing the reasoning must never leak another bot's
tools into a bot that should not have them, and must never let a bot
act outside its approval gates.

Branch: `feat/shared-reasoning-2026-11-19`, from main `9e442fdb`.
Design record for the repo's spec-before-code rule; the code is
`src/services/bots/{reasoning,scoped-tools,turn,outcomes}.ts` plus
the wiring in `group.ts`, `registry.ts`, `router.ts`, `store.ts`,
and the webhook route.

## 1. The ten reasoning forms — exactly as they exist in the code

Every bot gets all ten, through the one shared brain. No per-bot
cut-down versions. (Owner GO 2026-11-10, plus temporal 2026-11-07.)

| # | Form | Code constant | First words |
|---|---|---|---|
| 1 | temporal | `TEMPORAL_RULES` | "TIME: never work out a weekday…" |
| 2 | contextual | `CONTEXTUAL_RULES` | "CONTEXT: hold the whole thread" |
| 3 | causal | `CAUSAL_RULES` | "CAUSE BEFORE CONCLUSION" |
| 4 | practical | the PRACTICAL paragraph inside `TOOL_SELECTION_RULES` | "PRACTICAL: fit the action to the moment" |
| 5 | self-correction | `SELF_CORRECTION_RULES` | "OWN YOUR MISTAKES" |
| 6 | episodic | `EPISODIC_RULES` | "EPISODES, NOT JUST FACTS" |
| 7 | theory of mind, first-order | `THEORY_OF_MIND_RULES` | "WHAT HE KNOWS" |
| 8 | value learning | `VALUE_LEARNING_RULES` | "LEARN WHAT HE VALUES FROM WHAT HE DOES" |
| 9 | consolidation, usage side | `CONSOLIDATION_RULES` | "USE WHAT YOU ALREADY LEARNED" |
| 10 | knowing when to shut up, conversation side | `RESTRAINT_RULES` | "KNOW WHEN TO STOP" |

Plus the five think-deeper forms (owner GO 2026-11-11, Frontier 1),
also shared whole: **chained** (`CHAINED_REASONING_RULES`, "PLAN THEN
ACT"), **self-verification** (`VERIFICATION_RULES`, "CHECK BEFORE YOU
SEND"), **honest uncertainty** (`UNCERTAINTY_RULES`, "SAY WHAT YOU
DON'T KNOW"), **trade-off math** (`TRADEOFF_RULES`, "SHOW BOTH SIDES
OF THE MATH"), **causal prediction** (`PREDICTION_RULES`, "FORECAST,
DON'T BLOCK").

All fifteen blocks live in `src/services/bots/reasoning.ts`, moved
verbatim from `src/services/bot/agent-turn.ts` (initializers verified
byte-identical). `SHARED_REASONING_TEXT` is the same blocks in Abel's
prompt order; `buildBotSystemPrompt(slug)` puts a bot's identity, its
scope line, the propose-only rule, plain-talk + pay-safety, and that
exact string together. Only the identity and the scope line differ
between bots. The prompt-presence tests pin every block present
exactly once in Abel's prompt and in each bot's prompt
(`agent-turn.test.ts` + `tests/unit/services/bots/reasoning.test.ts`).

## 2. Audit — what each bot had vs what it now gets

Audited 2026-11-19 against main `9e442fdb` (PR #96 baseline, live
v114). Abel's 1:1 brain is `src/services/bot/agent-turn.ts`
(`runAgentTurn`, 1,735 lines) + `src/services/bot/tools.ts`
(registry, 160 tools — 159 at the audit, plus list_malik_call_reports from PR #98) + `src/services/ai/agent-loop.ts`
(`runAgentLoop`).

| Piece | Abel 1:1 (before) | Other bots in the group (before) | Now (this PR) |
|---|---|---|---|
| The ten reasoning forms + five think-deeper | Full system prompt, assembled in code | None — Abel's group path was a bare `runBotChat` with no reasoning blocks; Scout was regex-only, no model call at all | All seven bots, byte-identical reasoning section (`reasoning.ts`, `turn.ts`) |
| Tools | Full 160-tool registry (159 at the audit, plus list_malik_call_reports from PR #98), dynamic per-turn selection (`selectToolsForTurn`, budget 120), `find_more_tools` over the full catalog | None in the group | Scoped read catalog per bot (`scoped-tools.ts`): reads only, inside the bot's registry scope; the loop's catalog IS the same filtered list, so `find_more_tools` can never surface an out-of-scope tool |
| Company snapshot | `loadBotContext` + `formatCompanySnapshot` | None (the group handler's own header called this a Phase 1 gap) | Every turn loads it via the brain store; on failure the turn proceeds WITHOUT it and the prompt says so |
| Memories | Instruction memories + retrieved facts + latest summary | Only that bot's `bot_team_memories` rows, as bare instructions | Own memories (facts/rules/preferences) + correction watch-outs + recent load outcomes (Scout), as context blocks |
| Corrections-learning | A field fixed twice becomes a watch-out (`correction-watchouts.ts`, threshold 2) | None — no write method for memories existed | Same threshold, same shape (`outcomes.ts`): a denied load draft's Auditor flags become correction memories; second correction of a field writes a watch-out |
| Judgment / propose-only | Model-execute guard (`isWriteAlreadyPending`), proposals staged, owner's yes executes | Guardrails (`guardrails.ts`) existed but the group turn had no model to stage through | Same gates in the turn: spend cap before the model call, `checkBotAction` + Auditor recomputation on every staged draft, dedupe at persistence time, proposals wait for his yes; the loop stages (`alwaysPropose`) and never executes |
| Grounding | `staleFiguresInReply` self-verification pass + `ungroundedAmounts` stripping, inside the loop | None | Same — the group turn runs the same `runAgentLoop` |
| Group history | Full thread (12 messages) | None (`history: []`) | Last 10 group messages, oldest first, from `bot_group_messages` |
| Nightly consolidation | `consolidation.ts` + scheduler (hourly tick, due after 20h, advisory lock 727002) | None | Stays Abel-only — see §4 |

Per-bot catalogs (reads only; writes are propose tools, §3):
Abel = all read groups except abel-only — including
`list_malik_call_reports` (PR #98: Malik's call reports reach Abel;
no other bot's governing file gives it that channel).
Abel = all read groups except abel-only. Scout = loads + hos + money
+ documents + email + maps. Tracker = loads + hos + documents + maps
+ email. Watchdog = loads + hos + documents. Maintenance = loads +
money + documents + email + maps. Billing = loads + money + documents
+ email. Auditor = all six read groups. `when_is` / `time_between`
are "shared" (pure date math). Memory, twin, thread, episode, game,
news, research, calls, business-credit, way-home, and learning-report
tools are "abel-only" — never in any bot catalog. Calling tools are
excluded from ALL group turns (calls go through approved call plans
only).

Registry scope fixes in this PR (governing file governs):
Maintenance `maps` none → read (nearest shop, route to the shop);
Compliance Watchdog `maps` read → none (governing file: no access);
Tracker `email` none → read (governing file: write-gated — sending
stays proposal-gated, so the turn offers reads).

## 3. Propose tools — a bot's only writes

`scoped-tools.ts` (`botProposeTools`): per-bot write tools with
`access: "write"` + `alwaysPropose: true`. The loop stages them and
NEVER calls `run()` in-loop; the turn persists them to
`bot_proposals` only after `checkBotAction` + (for load drafts and
shortlists) `auditLoadDraft` in code. The reply gets a "waiting for
your yes" suffix matching the group decision grammar.

- All bots except Auditor and Watchdog: `propose_message`.
- Scout: `propose_load_draft`, `propose_shortlist`.
- Tracker: `propose_status_update`. Maintenance: `propose_work_order`.
- Billing: `propose_invoice`.
- Auditor and Watchdog: none — they flag by replying in the group;
  a flag is their answer, not a record.
- Abel in the group gets only `propose_message`: load work belongs
  to Dispatch Scout, and Abel routes it there instead of drafting
  it himself.

## 4. What stays Abel-only, and why

- `AGENT_SYSTEM_PROMPT`, `FLEET_RULES`, `LEARNING_RULES`,
  `EMAIL_RULES` — Abel's 1:1 machinery (dump staging, threads,
  twin, research engines, email sending), not reasoning.
- The 1:1 code paths (pending-action resolution, quote resolution,
  waiting list, status talk, email staging, dump intake,
  photo-purpose asks).
- The full WRITE registry — bots never get Abel's write tools.
- Memory tools (`list_memories`, `search_memory`, `save_memory`) —
  bots get their own memories as context blocks instead. Where a
  shared rule names a tool a bot doesn't have, the bot's scope line
  tells it to say so and propose through its propose tools.
- Research engines, twin, thread machinery, episode/game/news tools.
- The nightly consolidation pass — company-scoped, rides the
  research invoker; bots get watch-outs + outcomes in-context
  instead. Wiring consolidation per bot is a later phase, not a
  gap in the reasoning: the learning *block* differs in source
  (Abel: `bot_proposal_outcomes`; bots: audit log + ledger) but the
  mechanism shape (outcomes → watch-outs → prompt) is the same.

## 5. Telegram shape — individual faces, handoffs inside the app

Owner rule 2026-11-19: **each bot its own Telegram account +
profile photo, messaging as itself in the group — the one-face
model was rejected.** (The open-source research recommended one
BotFather bot as the group's only face. The owner rejected that
shape; this design follows the owner's ruling, and reports the
mechanic that blocks the full picture, as he ordered.)

**The blocking mechanic, verified against Telegram's own Bots FAQ
(core.telegram.org/bots/faq, read 2026-11-19):** "Bots talking to
each other could potentially get stuck in unwelcome loops. To avoid
this, we decided that bots will not be able to see messages from
other bots regardless of mode." And: "Bot admins and bots with
privacy mode disabled will receive all messages except messages
sent by other bots." A narrow exception exists (Bot-to-Bot
Communication Mode + a command mention or a direct reply), but it
is fragile and not a basis for the room.

What that means, exactly:
- Each bot CAN post as itself (own account + photo) — that part works.
- Each bot CAN see the owner's messages (privacy off / admin) — the
  "every bot hears every message" picture holds for the owner's
  messages.
- No bot CAN see another bot's message — so a bot's message naming
  another bot is never delivered to that bot, and handoffs cannot
  travel through Telegram. Privacy Mode OFF does not fix this;
  making the bots admins does not fix this.
- Handoffs therefore travel inside the app: when a bot's answer
  names another bot by NAME (not a job word — "I'll dispatch this"
  is not a handoff to Scout), the group handler runs that bot's
  turn once with the handoff payload (objective + constraints +
  what was already said, never the whole conversation) and that bot
  answers under its own name. One hop per incoming message; the
  handoff turn is terminal, so the room cannot talk to itself.

Still to do (not this PR): the owner creates the other five
BotFather accounts (Abel's and Scout's exist); per-bot tokens go in
as Fly secrets and the webhook wires `sendAsBot` for each — Scout's
token is already set in Fly (TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN,
live since v115, 2026-11-19 ~2:43 PM CT) and the
webhook posts Scout's replies under his own account. Until a bot
has a token, the handler posts its replies through the group's bot
with the bot's name first. Still the owner's steps for Scout:
/setprivacy Disable for @DispatchScoutBot + add Scout to the Road
to Legacy Crew group.

Forum Topics per agent was considered and rejected: the owner
wants one flat team room, not topics. It stays a possible later
split if the room gets noisy.

## 6. Frameworks — evaluated, not adopted silently

Open-source multi-agent research landed 2026-11-19
(`~/workspace/research_notes/open-source-multi-agent-team-20261119-2022/report.md`).
Owner order the same day: the research must be USED NOW — the six
patterns applied immediately; Mastra adoption to be evaluated with
a recommendation, not adopted silently.

**Recommendation: do NOT adopt a framework in this PR.** The app
already has a working agent loop (`runAgentLoop`), tool registry,
guardrails, proposals, and spend caps — all wired, tested, and
live (v114). Adopting Mastra / the OpenAI Agents SDK / LangGraph.js
now would re-platform the live bot mid-build for no user-facing
gain. Re-evaluate when the team outgrows the hand-rolled loop
(durable workflows across restarts, or a second service) — that is
a separate decision with its own gate, and the evaluation below is
the starting point.

- **Mastra — first choice for that later evaluation.** TS-first
  agents, typed durable workflows, suspend/resume human-in-the-loop,
  PostgresStore via `@mastra/pg`, Apache-2.0 core. Caveat: the
  `ee/` dirs (RBAC/SSO/auth) are commercial-licensed — enforce
  permissions in our own code + RLS, never import `ee/`.
- **OpenAI Agents SDK (TypeScript) — simplest.** MIT, handoffs
  first-class. No durable execution — the queue/resume would be
  built on Supabase, which is what the existing code already is.
- **LangGraph.js — most durable, steepest.** MIT library,
  PostgresSaver maps to Supabase; JS port lags Python, docs are
  Python-first, hosted server is Elastic-licensed.
- **Avoided:** Microsoft AutoGen (archived Oct 2026), MetaGPT
  (stale since early 2026), ElizaOS (social/crypto personas,
  foundation wound down Aug 2026), CrewAI / AgentScope /
  Microsoft Agent Framework (Python/.NET — wrong stack), Vercel
  eve (public beta 0.x — watch, don't bet the business), CAMEL
  (research, not production). No open-source project runs a small
  business end-to-end in Telegram — there is no example to copy
  wholesale; the patterns below are borrowed, not a project.

**The six patterns, applied in this PR (not later):**
1. **Supervisor-first** — Abel as coordinator routes
   (`router.ts`, allow-listed routes); workers return to shared
   state; the coordinator owns the final message.
2. **Handoff payload = validated state only** — objective +
   constraints + run id + what was said; never the full
   transcript (`turn.ts` handoff block, `group.ts` one hop).
3. **Shared state/summaries, not full transcripts** — turns load
   memories + outcomes + the last 10 group messages, never raw
   transcripts.
4. **One model router + per-agent scoped tools** —
   `scopedToolCatalog` + one provider; the loop's catalog IS the
   scoped list.
5. **Server-side enforcement, not prompts** — catalog filter +
   `checkBotAction` + `alwaysPropose` staging in code. (Postgres
   RLS per bot is future hardening: today's 00103 policies are
   SELECT-only, and the 00103 file-fix PR is still owed. This PR
   enforces in server-side code, not in RLS yet — said precisely.)
6. **Human-in-the-loop as a structural interrupt, not a prompt**
   — proposals are rows awaiting his yes; the loop stages and
   never executes. The parallel to Mastra `suspend()` / LangGraph
   `interrupt()`.

Plus the loop guards the research names: single-writer per
thread (one update at a time; proposals deduped at persistence
time), bounded loops (`TOOL_BUDGET` 120, `MAX_AGENT_STEPS` 6,
one handoff hop), idempotency by same tool + args. Full
pg-boss-style job claiming is future (Phase 1 boards work).

## 7. Malik

Malik gets the shared reasoning via `formatSharedReasoning()` —
his phone assistant composes its instructions from the same text
plus its own identity block. This PR does NOT wire Malik itself
and does NOT touch `calling/malik-tools.ts` or any Telnyx/calling
code (separate crew, own branch). The only shared file is
`agent-turn.ts`, and this branch's change there is import-only
(mechanical, at the top of the file), so a merge conflict is
unlikely; if the Malik crew also edits `agent-turn.ts` imports,
git should auto-resolve or need a one-line manual resolution.

## 8. Merge notes

- This PR merges first (owner: merge-when-ready). Scout PR #97
  touches `group.ts` (scan branch, denied-shortlist ledger write,
  Scout fallback line) — same hunks this branch touches; #97
  rebases after this merge.
- PR #98 leftover fixed here: its new tool broke the pinned
  registry count in `agent-turn.test.ts` (159 → 160); PR #98's
  gate ran its own files only. Re-pinned with the measurement
  trail, since this branch classifies the new tool anyway.
- No migration in this PR. No new tables. No secrets.
  Propose-only enforced in code, not just in prompt text.
- No deploy — deploy stays a separate word from the owner.
