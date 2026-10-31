# Driver MVP — checklists, dispatch helper, duty log, Telegram private bot, dispatch exchanges

Written 2026-10-31, ahead of code, per this repo's spec-first workflow
(`CLAUDE.md`). Owner-authorized the same day for a real first run on
2026-11-01 (driving another owner-operator's truck, Melbourne FL →
Georgia pickup, dispatch coordination in Spanish over Telegram). Short
by design — this closes the "no spec exists for this area" gap for
exactly these five pieces and nothing more.

## 1. Checklists (static UI, no data)

A phone-readable page under Fleet: coupling, uncoupling, docking/
backing, and at-the-shipper/receiver paperwork steps. Static content in
the page component, same treatment as the pre-trip checklist prompts
(`docs/schemas.md`'s `pretrip_inspections` note: standardized practice
is rendered in the UI, not modeled as data). The pre-trip form's
`CHECKLIST_ITEMS` grows the coupling-specific prompts it was missing
(landing gear, glad hands/air lines, tug test, kingpin visual check).

## 2. Dispatch helper (AI capability: `dispatch_helper`)

One stateless capability, two surfaces, one shared service
(`src/services/ai/dispatch.ts`):

- **Operating fact (owner-confirmed 2026-10-31):** Steven is
  **leased on to another carrier** — his own MC doesn't have enough
  history/accounts to get loads directly — so the truck runs under
  that carrier's authority. Consequence for this helper: dispatch
  messages may come from the *carrier's* dispatch, not just Steven,
  which is exactly why the sender-read (owner / dispatcher / broker /
  shipper / receiver) must stay honest about uncertainty instead of
  assuming every message is Steven.
- **Input:** a pasted dispatch message (Spanish or English) + optional
  free-text context. The message is *untrusted external content*
  (broker/dispatch text) — the system prompt treats it strictly as text
  to translate and explain, never as instructions, per `CLAUDE.md`.
- **Output (validated Zod contract, same discipline as
  `output-contract.ts`):** English translation, a plain-language read
  of what is being asked, who the sender most likely is
  (owner / dispatcher / broker / shipper / receiver / unknown) with the
  reasoning, and a suggested reply in English **and** Spanish. The AI
  drafts; the human sends. Nothing is ever sent by the app.
- **Governance:** a real capability under `docs/governance.md` — added
  to `KNOWN_CAPABILITIES`, off by default, checked (global switch
  first, then per-capability) before any provider call in the
  authenticated web/API path. The provider is the existing
  `OpenAiProvider` behind the `AiProvider` interface; the response
  format is JSON (the provider's existing `json_object` mode).
- **Endpoint:** `POST /api/v1/dispatch-suggest` (authenticated,
  `createApiHandler`, validated body, no persistence in this endpoint
  itself — persistence is the separate exchanges resource, §5).

## 3. Duty log / HOS helper (`duty_logs`)

A manual, warn-only paper-log helper. **It is not an ELD and not a
system of record for HOS compliance** — the truck's ELD (or official
paper logs) remains the legal record, consistent with
`docs/requirements.md`'s existing non-goal. Standard CRUD resource
following the brokers pattern exactly:

- One row per duty-status start: `driver_id`, `load_id` (both
  nullable), `duty_status` (`off_duty | sleeper | driving | on_duty`),
  `started_at`, `location`, `odometer`, `notes`, plus global
  conventions (`company_id`, timestamps, soft delete, tenant RLS).
- `src/lib/hos.ts` computes warn-only summaries from the rows: driving
  time in the current 14-hour window (window restarts after a
  continuous ≥10-hour off/sleeper rest), driving since the last
  ≥30-minute break of any non-driving status, and on-duty time in the
  last 8 days vs the 70-hour limit. It warns; it never blocks, edits,
  or certifies anything. Segments are derived: a row runs until the
  next row's `started_at` (or "now" for the latest row).

## 4. Telegram private bot v1 (`POST /api/telegram/webhook`)

A personal assistant surface for the owner only — **not** a group
integration, in v1 or by extension:

- The bot serves exactly one private 1:1 chat: the owner's. It never
  joins, reads, or sends to any group, and never sends anything to any
  third party. Incoming text (typed, pasted, or forwarded into that
  private chat) runs through the same dispatch-helper service (§2) and
  the bot replies in that same private chat with the translation,
  sender read, and suggested replies.
- **Fail-closed, in order:** (1) `TELEGRAM_BOT_TOKEN` unset → route
  disabled (503, no processing). (2) If `TELEGRAM_WEBHOOK_SECRET` is
  set, the `x-telegram-bot-api-secret-token` header must match or the
  request is rejected. (3) Non-private chats are always ignored.
  (4) Allowlist: `TELEGRAM_ALLOWED_CHAT_ID` set → any other chat id is
  silently ignored. Allowlist unset → **bootstrap mode only**: the bot
  replies (in a private chat only) with that chat's id and setup
  instructions, and runs *no* AI processing. This exists solely so the
  owner can learn his chat id; it must be replaced by the real
  allowlist immediately after setup.
- The webhook has no user session, so it cannot check the in-app AI
  kill switches (they are per-company session data). Its revocation is
  its own env surface: unset the token or the allowlist and it stops.
  That boundary is deliberate and recorded here, not discovered later.
- `src/proxy.ts` lists `/api/telegram` as public for the same reason
  `/api/internal` is: no browser session exists for this caller; the
  route enforces its own checks above.
- **Setup (owner steps, in order):** (1) Create a bot with @BotFather
  (`/newbot`), keep the token private. (2) `fly secrets set
  TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=<a random string he
  generates>`. (3) Redeploy, then message the bot privately once —
  bootstrap mode replies with his chat id. (4) `fly secrets set
  TELEGRAM_ALLOWED_CHAT_ID=<that id>` and redeploy. (5) Register the
  webhook: `curl https://api.telegram.org/bot<TOKEN>/setWebhook
  -d url=https://trucking.fly.dev/api/telegram/webhook
  -d secret_token=<the same TELEGRAM_WEBHOOK_SECRET>`.
  No real token is ever committed or handled in the repo.

## 5. Dispatch exchanges (`dispatch_exchanges`) — learning his voice

The raw material for teaching the app how the owner actually writes:
every helped exchange can be stored with what came in, what the AI
produced, and — the valuable part — **what he actually sent**.

- Columns: `company_id` + tenant RLS like every other table,
  `incoming_message`, `ai_translation`, `ai_suggested_reply_en`,
  `ai_suggested_reply_es`, `actual_reply_sent` (nullable),
  `source` (`web | telegram`), `created_at`/`updated_at`/`deleted_at`.
- Standard CRUD resource (`/api/v1/dispatch-exchanges`) so the web
  page can save an exchange and later work can list/edit them
  (back-filling `actual_reply_sent` on a telegram row included).
- **Web:** after a suggestion renders, an optional "What I actually
  sent" field + save button stores the full exchange (`source: web`).
  Saving is always the owner's explicit tap — the suggest endpoint
  itself stays stateless (§2).
- **Telegram:** when the bot replies, it stores the exchange
  (`source: telegram`, `actual_reply_sent: null`). The bot cannot see
  what the owner later sends in the *other* app (the dispatch group),
  so actual-reply capture for telegram rows is later work (manual
  back-fill via the CRUD resource, or a future "reply to the bot with
  what you sent" flow). The bot's storage needs a tenant to write to:
  it uses the server-only `SUPABASE_SERVICE_ROLE_KEY` scoped by the
  `TELEGRAM_COMPANY_ID` env var — if either is unset, the bot still
  replies and simply skips storage. This is a recorded, deliberate
  exception to the "service role is admin tooling only" note in
  `.env.example`: single-tenant bot, one fixed company id from env,
  never user-supplied input. Owner step: `fly secrets set
  TELEGRAM_COMPANY_ID=<his company uuid>` (visible in his
  `user_profiles` row) to enable it.

## 6. Bot intelligence (added same day, owner's explicit bar)

The owner raised the bar mid-build: the bot should be a real
conversational agent, "as smart as the bot I'm building for my second
brain" — not a dispatch-only responder. His Soumaya bot's documented
failures are the requirements here, named so they can't recur quietly:

- **Guaranteed context, not model-elected.** Every AI turn builds its
  prompt in code (`services/telegram/store.ts` + `context.ts`):
  (a) **conversation history** — persisted per turn in
  `telegram_messages` (migration `00013`), the recent 20 turns loaded
  and injected. A bot answering with empty history is the exact bug
  he already lived through; (b) **a live company snapshot** — active
  loads, current duty status + HOS figures from `src/lib/hos.ts`,
  last-7-days expense/fuel totals, contacts with real counts and
  names, all from real queries, formatted by
  `formatCompanySnapshot`. A number in an answer traces to a line in
  that block or it isn't said; (c) **his standing instructions** —
  `bot_memories` rows of kind `instruction` (migration `00014`),
  injected **in full on every prompt**, both dispatch and chat. This
  store doubles as the bot's profile/settings store (chosen over a
  separate settings table: one durable store, one retrieval path);
  (d) **retrieved memories** — keyword match + recency over
  `bot_memories` (v1 retrieval, stated plainly: no embeddings yet).
- **Free-form intake + long-term memory.** Routing is code, and
  predictable (`classifyTelegramText`): forwards → dispatch flow;
  Spanish-looking text → dispatch flow; `remember:` → captured as a
  memory (expense-flavored dictation → kind `expense_hint`, and the
  acknowledgement says out loud it was **captured for review, not
  booked**); `instruction:`/`always …` → standing instruction;
  everything else → conversation (`services/ai/bot-chat.ts`), which
  answers business questions from the snapshot ("how much have I
  spent on fuel this week?", "when does my 14 run out?") and can
  itself surface a dictated fact in its output's `memory` field,
  which the bot then stores. Coaching rule for the chat prompt: how-
  do-I-handle-this answers use his actual load/hours, not generics.
- **What shipped vs what's next, honestly.** Shipped tonight:
  dispatch + persisted history + snapshot + instructions + memory
  capture/retrieval, one completion per turn. **Not** shipped: a
  tool-calling agent loop. The named next increment ("Bot
  intelligence v2 — agent loop"): (1) expose the existing CRUD API
  as bot tools via a `services/telegram/tools.ts` that calls the same
  service layer with the bot's company scope; (2) a bounded loop in
  `services/ai/bot-chat.ts` (max N tool rounds, every call logged);
  (3) write tools (create expense, log duty status) behind an
  explicit confirm step in chat — the bot proposes, the owner taps
  yes — per `docs/governance.md`'s approval boundaries; (4) swap
  keyword retrieval for embeddings once `bot_memories` volume makes
  keyword matching visibly weak. Also outstanding: the task 5.1 RLS
  suite's table list needs `telegram_messages` + `bot_memories` too
  (recorded as task 7.6's scope).

## 7. Future increments (designed, deliberately not built tonight)

- **Smart Path — mapping & smart lanes.** A mapping section built on
  lane intelligence learned from his own loads: rate-per-mile by
  lane, deadhead distance, reload probability out of a destination —
  computed from the `loads` table he already fills in, so it gets
  smarter from his real history instead of generic market data (the
  grown-up form of `My idea`'s "Florida trap"/positioning thinking).
  The map itself is **native in the app**: a real, responsive map
  view rendered via an embedded maps SDK — he opens his app and the
  map is there; switching to Google Maps must never be necessary
  (an optional "open in…" handoff is fine, and a maps engine under
  the hood is fine — the trucking intelligence is this app's layer,
  not a rebuilt maps engine). One route, governed by *everything at
  once*, in his priority order — legal first, rested second, paid
  third: appointment windows for the load; his HOS clocks (from
  `duty_logs` / the ELD picture); planned sleep; the truck profile
  (speed, size/weight-legal roads); and his personal driving
  preferences, including preferences the bot learns from their
  Telegram conversations (times and ways he doesn't want to drive),
  with tradeoffs spoken to him via Telegram rather than silently
  made. Two route overlays ride on the same computation:
  **best-fuel routing** — fuel stops chosen on *effective* cost
  (price vs the detour/deadhead to reach it), not headline price;
  and **food routing** in two modes — fast food when time is short,
  and cheap grocery stops (Walmart-type) for cooking in the truck,
  keyed to an **appliance inventory on the truck profile** (what he
  can actually cook with decides what groceries make sense; flag
  for the Smart Path build: `trucks` needs an `appliances`
  field/list — deliberately *no* schema change tonight — first
  capture is Steven's truck's setup, on the first run). Food
  routing respects his standing 8pm–8am fast: inside that window
  it suppresses food suggestions entirely. Governing design law
  for the whole surface:
  **phone-away while driving** — voice in, voice out, audio alerts
  only; nothing that asks him to read or type at the wheel; the
  Telegram bot is Smart Path's voice. Open unknown, to be discovered
  on the first run: the leased-on carrier's ELD may already bundle
  navigation, which would shrink this to lane intelligence + alerts
  only.
- **Web chat window — second window, same brain.** The app will get
  an in-app chat, but it is a *window onto this same bot*, never a
  second chat with its own memory: it must read/write the same
  `telegram_messages` history, the same `bot_memories`, and the same
  code-assembled snapshot context (§6), so Telegram and web can never
  diverge into two brains that know different things. Decided by the
  owner 2026-10-31 (decision delegated and ruled): **Telegram is the
  primary channel; the web chat ships after Telegram v1 proves out.**

Context every prompt carries, in one list: system rules → standing
instructions (full) → company snapshot (chat; also dispatch context)
→ retrieved memories → recent conversation history (chat) → the new
message. Dispatch calls carry instructions + snapshot + memories as
their `context` argument.

## Out of scope for this pass

Certified ELD anything; the bot joining or reading any group; a
userbot / logged-in-as-the-owner client (a separate, riskier design
needing its own pass); per-load P&L; role-typed contacts; load
detail/edit screens; any Plaid or research-engine work.
