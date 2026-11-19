# Malik real tools — design (2026-11-19)

Owner ruling, 2026-11-19 voice call: Malik cannot stay "just a voice with a
script". He must have the tool sets he needs and do real dispatcher work on
calls. This doc is the spec; the code in this branch implements it.

## Verified starting state (2026-11-19, live Telnyx read)

- Telnyx AI assistant "Malik", id `assistant-68fca3cb-be34-4801-beea-aa58d320b33b`,
  model `zai-org/GLM-5.3-Flash`, voice ElevenLabs `eleven_v4` Will
  (`bIHbv24MWmeRgasZH58o`).
- `tools: []`, `mcp_servers: []`, `integrations: null`,
  `dynamic_variables_webhook_url: null`. No connection to the trucking app.
- Instructions say he handles check-calls, ETAs and load questions, never
  invents load details, and takes a message when asked for a human.
- The app already has a Telnyx webhook (`/api/telnyx/webhook`, Ed25519-verified
  with `TELNYX_PUBLIC_KEY`) and the Fly calling secrets are live.
- Abel's tool registry (`src/services/bot/tools.ts`, `buildBotTools`) is the
  pool this design draws from. Nothing in it was guessed: every tool below
  names the Abel tool or service it reuses.

## The six tools Malik gets

All six are webhook tools on the Telnyx assistant. Each one reads the owner's
own company data through the service-role client, scoped to one company id
in code. Every call is logged (see § Bridge). None of them books, pays,
signs, or moves money. None of them offers a human handoff; the instructions
already forbid that unless the caller asks.

| Tool | Reads | Abel source it reuses |
|---|---|---|
| `malik_get_active_load` | The active load, or one load by trip number: lane, status, pickup/delivery windows, filed rate, miles, broker name. | `pickActiveLoad` (`lib/active-load.ts`); `list_loads` shape |
| `malik_get_delivery_eta` | Delivery window + route ETA from the truck's last known position + drive time left in the 14-hour window. Says plainly when no route could be computed and why; never estimates miles or an ETA. | `buildActiveLoadState` / `describeActiveLoadState` (`services/navigation/active-load-state.ts`) — the same state the Home map reads — plus `loadHosWindow` |
| `malik_get_hos_hours` | Current duty status, driving used in the 14-hour window, driving since the last 30-minute break, cycle position, warnings. Paper-log helper figures, labeled as such. | `loadHosWindow`, `cycleLine`, `hosWarnings` (`services/api/hos-window.ts`) — the same snapshot as Abel's `hos_summary` |
| `malik_get_trip_status` | Trip status in one answer: active load + next stop, current duty status, last known position age, detention clock state. | `buildActiveLoadState` + `computeDetention` (`lib/detention.ts`) + the latest duty log |
| `malik_get_load_paperwork` | A load's paperwork completeness: rate confirmation, BOL / proof of delivery, scale ticket, lumper receipt. | `computePaperwork` (`lib/paperwork.ts`) — the same check as Abel's `get_load_paperwork` |
| `malik_take_message` | **The only write.** Records a message taken on a call (caller name, callback number, message, load ref if given) as a call report, and attempts delivery to Abel (see § Reporting). | New; stored in `malik_call_reports` (migration 00104) |

Why these six: a broker, shipper, or receiver on the phone asks exactly
these things — "where's the load", "when will he be here", "can he make the
window", "what's his hours", "do you have the rate con", "take a message".
Everything else is either Abel's job or not call work.

## Deliberately NOT given to Malik

- `place_call` / `list_outbound_calls` — Malik answers calls; he never places
  them. Outbound calls are Abel's `place_call`, always proposed first.
- All money writes: `create_expense`, `create_fuel_purchase`,
  `create_load_invoice`, `update_load_invoice`, `record_settlement`,
  `set_pay_terms`, `confirm_paycheck`, `set_pay_pin` — no money moves on a
  phone call.
- All load mutation: `create_load`, `update_load`, `complete_load`,
  `set_load_stops`, `attach_document` — a caller on the phone must not change
  a load record.
- `log_duty_status`, `stamp_detention` — HOS and detention entries come from
  the driver at the wheel / at the facility, with provenance. A phone caller
  must not move the paper log.
- `save_memory`, `save_agent_lesson`, `record_preference`, `learn_driver_patterns`
  — Malik does not write Abel's long-term memory or the driver model.
- `send_email`, `draft_email_reply`, `send_inspection_packet`,
  `send_inspection_packet_to_me` — no outbound messages from a call.
- `delete_record`, `revise_pending_item`, `stage_dump_items` — proposal
  machinery is Abel / owner only.
- `evaluate_pay_offer`, `lane_rate_history`, `projected_pay` — pay math on a
  live call from a broker's spoken numbers is exactly how invented figures
  happen. Malik quotes only the filed rate from the load record; he never
  computes or negotiates an offer.
- `search_memory`, `search_memories`, `search_dispatch_exchanges`,
  `list_memories`, `get_credential_watch`, `get_receivables`,
  `get_cash_calendar`, `get_ifta_worksheet`, `get_tax_packet`,
  `list_business_credit_accounts`, `news_digest`, `get_game_plan`,
  business-credit / research / game / twin / thread tools — not call work.
- `evaluate_plan`, `check_route`, `way_home`, `plan_my_run` — planning tools
  that take a plan in words and judge it; a live caller is not the owner
  describing a plan. (The ETA tool covers the "can he make it" question with
  the route + the HOS clocks, in code.)

## Bridge

One endpoint, one tool per URL segment:

```
POST /api/telnyx/malik-tools/[companyId]/[tool]
```

- Auth, in the same order as `/api/telnyx/webhook`: `TELNYX_PUBLIC_KEY`
  configured (else 503, fail closed), then Ed25519 signature over
  `timestamp + raw body` (else 401). Reuses `verifyTelnyxSignature`
  (`services/calling/telnyx.ts`) and `getCallingConfig`.
- `companyId` is baked into each tool's URL in the Telnyx assistant config
  (set once by King via the Telnyx API, from the attach script — it is NOT a
  model-chosen parameter and never comes from the call). The route checks it
  is a UUID and a real company; anything else is a 404.
- `[tool]` must be one of the six names above; anything else is a 404.
- The body is the flat arguments object Telnyx sends for a webhook tool
  call. Arguments are validated with zod; a bad argument returns a 200
  whose result says so in plain words (the assistant can repeat it), never
  an invented answer.
- Timeout: the tool definitions set `timeout_ms` 15000 for the ETA tool
  (route computation can take seconds on a cold cache) and 5000 for the
  rest. Handlers are read-only Supabase queries plus the cached route
  state; nothing in them waits on a human.
- Every tool call is logged to `malik_tool_calls` (migration 00104):
  tool name, arguments, result text (truncated), duration, conversation
  ref when Telnyx sends one. A logging failure is loud in the server log
  but never fails the answer — the caller still gets the truth; the log
  gap is visible.
- Response shape: `200 { "result": "<short plain-words grounding text>" }`.
  Telnyx hands the body back to the assistant as the tool result.
- No secrets anywhere in this branch: the endpoint reads env only
  (`TELNYX_PUBLIC_KEY`, Supabase URL + service-role key, Telegram token /
  group id). The Telnyx tool definitions file
  (`docs/design/malik-telnyx-tools.json`) carries `{COMPANY_ID}` and
  `{APP_BASE_URL}` placeholders — the real values are filled in by the
  attach script from env, never committed.

## Reporting: every call outcome reaches Abel

Abel is the coordinator and top-ranking bot; every bot reports to him, and
he decides what is worth a call to the owner. Malik is the phone voice, not
a Telegram bot, so his reporting runs through the app:

1. `malik_take_message` writes a `malik_call_reports` row (kind `message`)
   and attempts the group post below.
2. The Telnyx webhook (`/api/telnyx/webhook`) now also handles inbound
   calls: an event with no matching `outbound_calls` row is a call Malik
   answered. On `call.conversation.ended` it creates/updates a
   `malik_call_reports` row (kind `call-summary`, keyed by
   `telnyx_conversation_id` — one report per conversation, upserted, never
   duplicated); on `call.conversation_insights.generated` it fills in the
   transcript + outcome. The existing outbound flow is untouched — it still
   matches by `call_control_id` first.
3. Group post: when `TELEGRAM_GROUP_CHAT_ID` is configured, the report is
   sent into the group (via `sendTelegramMessage`, as the bot) and recorded
   in `bot_group_messages` (`sender_kind: 'bot'`, `sender_ref: 'malik'`) so
   the room's history carries it. When the group id is NOT configured, the
   report stays in `malik_call_reports` with `reported_to_group = false` —
   it is never lost, and Abel's new read tool surfaces it.
4. Abel's new read tool `list_malik_call_reports` (in `buildBotTools`) lists
   the newest reports for the company: kind, title, body, whether it reached
   the group. This is how Abel sees Malik's calls in 1:1 chat today, before
   group mode is live.

What is still missing (stated plainly, not hidden):
- The Telegram group itself is not wired yet: `TELEGRAM_GROUP_CHAT_ID` is
  not set on the server, so group delivery is pending the owner's step
  (make the group, tell King the id). Until then reports land in the
  database + Abel's read tool only.
- The tools are NOT yet attached to the live Malik assistant. Attaching
  (tools + the new instructions below) is a live Telnyx change via
  `scripts/malik-attach-tools.mjs` — it needs the owner's word and is NOT
  run in this branch. Until it runs, Malik is still the script-only voice
  on live calls.
- Tool calls carry no call id in Telnyx's flat-args body, so a tool-call log
  row cannot be tied to a specific conversation except by time proximity.
  The call-summary report (transcript + outcome) is the per-call record.

## New assistant instructions (applied at attach time, not in this branch)

> Your name is Malik. You are the dispatch voice for Road to Legacy
> Trucking, speaking for owner-operator Sajacous Smith. You answer the
> company's phone line. For any question about a load, an ETA, hours, trip
> status, or paperwork, USE YOUR TOOLS — look it up live, never answer from
> memory and never invent a load detail, time, address, or pay figure. If a
> tool says it cannot read something, say that plainly. When someone asks
> you to take a message, use the take-message tool with their name, number,
> and what it is about, and tell them you will pass it to Abel. Never offer
> to transfer the caller to a human unless they explicitly ask to speak to
> Sajacous or ask for a human. Never book, pay, sign, or promise anything
> on a call. Keep answers short and plain.

## Guardrails (never bend)

- Propose-only stays: Malik never books, pays, signs, or moves money, and
  never offers a human handoff unless the caller asks. The only write in
  this branch is taking a message — a record, not an action.
- NOTHING from Steven's company goes in the app: no carrier name, DOT/MC,
  insurance, filings, driver file, or drug-testing program. The owner's own
  data (his loads, hours, pay) is what the tools read.
- Tenant isolation: every table is RLS by `company_id`; the service-role
  client filters by company in code; no authenticated write policies.
- Honest states only: no route / no position / no load = the tool says so
  in plain words. A guess is never presented as a fact.
- No UTC in anything user-facing; times are labeled in the truck's / home
  zone as the underlying services already do.

## Files in this branch

- `docs/design/malik-real-tools.md` — this spec.
- `docs/design/malik-telnyx-tools.json` — the six Telnyx webhook tool
  definitions (placeholders for company id + app URL).
- `scripts/malik-attach-tools.mjs` — attach script (tools + instructions
  to the live assistant). NOT run in this branch.
- `supabase/migrations/00104_malik_call_tools.sql` — `malik_tool_calls`
  + `malik_call_reports` (RLS, `private.current_company_id()`).
- `src/services/calling/malik-tools.ts` — tool handlers, logging, group
  reporting.
- `src/app/api/telnyx/malik-tools/[companyId]/[tool]/route.ts` — the
  signature-verified endpoint.
- `src/app/api/telnyx/webhook/route.ts` — inbound call-summary reporting
  (outbound flow untouched).
- `src/services/bot/tools.ts` — Abel's `list_malik_call_reports` read tool.
- `tests/unit/services/calling/malik-tools.test.ts` — targeted tests.
- `PROJECT_STATE.md`, `TASKS.md` — landing record.

## Gate

All four on the exact branch tree, logs at
`~/workspace/builds/gates/malik-tools-2026-11-19/`:
- typecheck: PASS (`tsc --noEmit --incremental false`, exit 0)
- lint: PASS (eslint on the touched files, exit 0)
- targeted vitest: 16/16 PASS
  (`tests/unit/services/calling/malik-tools.test.ts`,
  `--pool threads --maxWorkers=2`)
- production build: PASS (`next build`, "Compiled successfully in 115s";
  the new route `/api/telnyx/malik-tools/[companyId]/[tool]` is listed as
  dynamic)
- No full `npm test` run: the targeted suite covers the new code; the full
  suite's known 5s-timeout flakes are environmental, not this change.
