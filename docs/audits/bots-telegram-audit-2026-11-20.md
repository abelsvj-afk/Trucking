# Focused Audit — Bots & Telegram Connections

> **Status:** Findings for investigation / NOT ACCEPTED  
> **Prepared:** 2026-11-20  
> **Repository:** https://github.com/abelsvj-afk/Trucking  
> **Audited base:** main at 6aa19c9ca3d521729ce159911676e1f3ff814c28  
> **Audit branch:** audit/bots-telegram-2026-11-20  
> **Report path:** docs/audits/bots-telegram-audit-2026-11-20.md  
> **Scope:** Telegram webhook ingress, private/group dispatch, per-bot identities, team-room routing, deduplication, rate limits, spend controls, proposal decisions, and connection health.

This is a focused source-code audit and handoff, not authorization to implement, merge, migrate, or deploy. No application code was changed.

## 1. Executive summary

The current code has several good safety foundations: production Telegram webhook requests fail closed without the webhook secret; secret comparison is timing-safe; the private Abel path is owner-chat allowlisted; the team group has a separate group-chat allowlist; private updates have durable update-id deduplication; bot-team spend is reserved before model calls and fails closed if the store is unavailable; and the bot proposal API now checks owner role.

The largest remaining risks are in the transition from one Telegram bot to multiple bot faces:

1. A non-Abel bot's private webhook is not routed as that bot. Private updates fall through to Abel's full private assistant path.
2. The first per-bot webhook to claim a group message can determine which bot token sends generic replies, so replies can appear under the wrong identity.
3. Group message deduplication fails open on non-duplicate storage errors and is skipped entirely when the team store is unavailable.
4. The shared rate limiter counts each bot's duplicate delivery as a separate incoming message.
5. The Billing bot-to-bot handoff branch bypasses the shared bot-chain depth gate.
6. Text prefixes can override the Telegram sender identity, despite the face module documenting prefixes as logging-only.
7. Telegram connection health currently checks only Abel's primary bot token/webhook, not every configured face.

These are source-level findings. The actual Fly secrets, Telegram webhook registrations, BotFather settings, and live Telegram delivery behavior were not available for this audit.

## 2. Scope and method

Reviewed current-main source for:

- src/app/api/telegram/webhook/route.ts
- src/app/api/v1/telegram-webhook/route.ts
- src/services/telegram/dispatch-bot.ts
- src/services/telegram/bot-api.ts
- src/services/telegram/store.ts
- src/services/telegram/burst.ts
- src/services/telegram/rate-limit.ts
- src/services/telegram/webhook-admin.ts
- src/components/settings/TelegramConnectionSettings.tsx
- src/services/bots/group.ts
- src/services/bots/router.ts
- src/services/bots/bot-channel.ts
- src/services/bots/faces.ts
- src/services/bots/registry.ts
- src/services/bots/store.ts
- src/services/bots/spend-guard.ts
- src/services/bots/spend.ts
- src/services/bots/billing.ts
- src/services/bot/agent-turn.ts
- src/services/bot/tools.ts
- src/services/bot/execute-gate.ts
- src/services/bots/guardrails.ts
- Relevant bot/Telegram migrations and unit tests.

No test command, typecheck, lint, build, real Telegram webhook, BotFather settings check, Fly secret read, or production database query was executed by this audit. The latest main commit message contains a report of passing gates, but that is commit-message evidence, not an independent run by this audit.

## 3. Findings

### BT-001 — Per-bot private webhooks execute through Abel's full private assistant
**Priority: P1 — authorization boundary / capability separation**

**Locations**
- src/app/api/telegram/webhook/route.ts: per-bot query parameter is parsed only in the group-chat branch; private updates continue below that branch.
- src/services/bot/agent-turn.ts: private agent turn builds the general buildBotTools(store) catalog.
- src/services/bot/tools.ts: general private tool catalog.
- src/services/bots/registry.ts: per-bot tool scopes, including Dispatch Scout's narrower read/draft scope.

The documented per-bot setup uses /api/telegram/webhook?bot=<slug>. The route reads ?bot= only after it has identified a group/supergroup update. A private message to a secondary bot falls through to the normal private Abel handler, which uses the primary TELEGRAM_BOT_TOKEN, the shared Telegram brain store, and the full private agent/tool catalog. The selected bot slug is not passed into the private agent turn or used to filter its tools.

**Impact:** A private chat with a bot intended to have a restricted role (for example, Scout) is not isolated to that role. It can be answered as Abel and may expose Abel's broader write-capable tools. This defeats the registry's least-privilege intent.

**Required design:** Either support direct chats per bot with a bot-slug-aware agent and enforced tool gateway, or reject/ignore non-Abel private webhooks until that work exists. Do not rely on prompt text to enforce a tool boundary. Add tests proving Scout cannot see or invoke Abel-only tools in a private chat.

### BT-002 — The webhook that wins the group claim can choose the reply's Telegram identity
**Priority: P1/P2 — identity correctness / multi-webhook routing**

**Locations**
- src/app/api/telegram/webhook/route.ts: groupBotToken is selected from the receiving webhook's ?bot= slug, then supplied as the generic sendMessage token.
- src/services/bots/group.ts: one shared group-message claim chooses the first webhook that handles the owner message.

Each bot's webhook can receive the same owner group message. The first handler to claim the shared room-message row proceeds. The generic sender passed to the group handler is bound to the token for the receiving webhook, not necessarily the bot selected by the router or the bot whose turn is executing. Scout has a dedicated sender and Watchdog has a partial special case, but generic Abel/Billing/Auditor and group proposal replies use the generic sender path.

**Impact:** If Scout's webhook wins the claim for a message routed to Abel or Billing, a generic response may be sent from Scout's account. The same race can affect approval acknowledgements and other group notices. The receivingBot value does not consistently determine the responding bot's identity.

**Required design:** Make outbound identity explicit per response (sendAs(botSlug, ...)) and select the token from the responding bot, never from whichever webhook happened to win. Alternatively, centralize group processing into one worker and route all outbound sends by target bot. Add a multi-webhook integration test that delivers one Telegram update to every configured face and verifies exactly one response from the correct account.

### BT-003 — Group-message deduplication fails open when the store errors or is unavailable
**Priority: P1/P2 — duplicate processing / side-effect safety**

**Location:** src/services/bots/group.ts, claimRoomMessage() and handleBotTeamGroupUpdate().

The room-message insert is the cross-webhook claim. A duplicate-key error correctly returns false, but any other storage error is logged and returns true so processing continues. If deps.store is null, the claim is skipped and the owner message still proceeds through group routing.

That fallback was documented for the earlier single-webhook arrangement. The current per-bot arrangement deliberately delivers the same owner message to multiple webhooks.

**Impact:** A transient insert failure, missing migration, or missing service-role configuration can let multiple webhook instances process the same message. Depending on the route, this can duplicate model turns, board scans, invoice/load proposals, bot handoffs, and owner replies. The monthly spend reservation limits total cost but is not an idempotency mechanism for a particular message.

**Required design:** Fail closed for side-effecting group turns when a unique claim cannot be established, or use a separate durable atomic claim service whose failure policy is explicit. If degraded read-only replies are desired, ensure they cannot scan, draft, stage, or trigger another bot. Test duplicate delivery, transient DB failure, missing store, and concurrent webhook arrivals.

### BT-004 — The shared Telegram rate limiter counts each bot's copy of the same update
**Priority: P2 — message loss / availability**

**Locations**
- src/app/api/telegram/webhook/route.ts: rate limit runs before group deduplication.
- src/services/telegram/rate-limit.ts: one in-memory limiter keyed by chat and update kind, not by Telegram update or receiving bot.

The group architecture expects the same owner message to be delivered to every participating bot webhook. Each delivery increments the same chat's rate-limit counter before the shared message claim rejects duplicates. The current message allowance is 60 deliveries per minute, not 60 distinct owner messages per minute.

**Impact:** With two active bot webhooks, the effective group-message allowance can be roughly halved; with more faces it shrinks further. A burst may be acknowledged with HTTP 200 and dropped before deduplication, so Telegram will not redeliver it. The owner may receive a drop notice even though the actual number of messages he sent was within the intended budget.

**Required design:** Rate-limit distinct Telegram updates after deduplication, or scope ingress limits per bot token and apply a separate owner/group logical-message budget. Keep Live Location traffic in its own budget. Add tests with multiple bot webhook deliveries of the same update.

### BT-005 — Billing's bot-to-bot handoff bypasses the bot-chain depth gate
**Priority: P2 — loop prevention / model-spend risk**

**Location:** src/services/bots/group.ts, the early sender.isBot / addressedToBilling branch and the later botChainDepth() / evaluateBotPickup() path; src/services/bots/bot-channel.ts.

The special branch for a bot message addressed to Billing claims the message and calls handleBillingGroupTurn() before the normal bot-chain depth is calculated and before evaluateBotPickup() is applied. The shared chain cap therefore does not govern this Billing handoff path.

**Impact:** A sequence of new bot messages that address Billing can trigger repeated Billing turns without passing through the common chain-depth cap. The spend reservation limits monthly estimated spend, but it does not prevent a rapid bot-message loop from consuming the available budget or flooding the room.

**Required design:** Apply the same sender identity, deduplication, chain-depth, and pickup verdict before every bot turn, including the Billing special case. Preserve the rule that Billing's own messages cannot trigger Billing again. Add a test with a bot chain at and beyond the configured depth that explicitly targets Billing.

### BT-006 — Room text prefixes can override the actual Telegram sender identity
**Priority: P2 — bot identity / audit provenance**

**Locations**
- src/services/bots/group.ts, sender.isBot branch: parseRoomSpeaker(botText) is used to set/override fromBotSlug.
- src/services/bots/faces.ts, parseRoomSpeaker() documentation says it is for logging attribution, not live routing.
- src/services/bots/bot-channel.ts, identifyTeamBot() reads BOT_REGISTRY.telegramUsername.

The face module describes the Name: ... prefix as a logging aid, while the group handler also uses that prefix to override the bot identity used for routing and handoff decisions. This means a message delivered by one bot account can be interpreted as another bot when its text starts with that bot's name. Separately, inbound username identification is sourced from BOT_REGISTRY, while per-face usernames are stored in BOT_FACES; those identity records are not one authoritative mapping.

**Impact:** A bot can be attributed to the wrong teammate, potentially waking a different route or creating misleading handoff/audit provenance. Bot identity should come from Telegram's from.username when a dedicated account is in use. Prefix parsing should be a narrowly scoped fallback only for the explicitly configured shared-token mode.

**Required design:** Establish one authoritative face registry (slug, username, token env name, active status); verify sender identity against it; do not let arbitrary message text override a known Telegram sender. For shared-token fallback, authenticate the shared account and treat the prefix as untrusted routing metadata with explicit validation. Test spoofed prefixes from each bot.

### BT-007 — Telegram connection health and repair cover only Abel's primary webhook
**Priority: P2 — operational visibility / recovery gap**

**Locations**
- src/services/telegram/webhook-admin.ts
- src/app/api/v1/telegram-webhook/route.ts
- src/components/settings/TelegramConnectionSettings.tsx
- src/services/bots/faces.ts

The settings endpoint calls getTelegramConfig(), which exposes only the primary TELEGRAM_BOT_TOKEN and shared webhook secret. getWebhookReport() and repairWebhook() call getWebhookInfo / setWebhook for that one token. The settings screen displays one connection status. It does not report or repair the Dispatch Scout webhook or any later bot face.

**Impact:** The UI can say Telegram is working while a secondary bot has no webhook, the wrong allowed updates, a delivery backlog, a bad secret, or an expired/invalid token. The current screen is accurate for Abel's primary bot, but it is not a team-wide Telegram health check.

**Required design:** Provide a per-face status list that reports token configured (never the value), Telegram getMe identity, webhook registered host, allowed updates, pending count, last delivery error/time, and secret configured. Add per-face repair that only reuses that bot's existing webhook URL and that bot's secret. Make the screen clearly distinguish “Abel connection” from “Bot team connections.” Bot-to-Bot Communication Mode is a BotFather-side setting and must still be verified by a functional group-message test; the current getMe status helper reports group-privacy capability, not the bot-to-bot mode itself.

### BT-008 — Connection repair UI has no action for some unhealthy states
**Priority: P2 — usability / recovery**

**Locations:** src/services/telegram/webhook-admin.ts and src/components/settings/TelegramConnectionSettings.tsx.

The UI only renders “Fix the connection” when the webhook is registered and the required-update list is missing entries. A missing webhook secret, a recent delivery error, or other unhealthy report can produce “Needs attention” without a repair button or a clear next action. A missing webhook URL also requires manual setup but the screen only states that an operator must set it.

**Impact:** The screen can identify an unhealthy state but leave the owner without a concrete next step. This matters most when Telegram silently stops delivering Live Location edits or button taps.

**Required design:** Map every unhealthy state to an explicit next action: safe in-app repair where possible, or exact server-side configuration needed where it is not. Do not display a generic repair button for a state the operation cannot fix.

## 4. Earlier audit findings rechecked against this main snapshot

Two important bot-team findings from the broad audit appear to have been addressed in this current-main source:

- **Proposal decision authorization:** src/app/api/bots/proposals/route.ts now explicitly requires ctx.auth.role === "owner" before POST decisions and records the authenticated user id in decided_by. The prior owner-role gap is not listed as an active finding here.
- **Bot model spend control:** src/services/bots/spend-guard.ts now refuses model calls when the store is absent or the reservation fails. It reserves the full reply estimate before the model call. Migration 00109 revokes function execution from PUBLIC/anon/authenticated and grants it to service_role. This addresses the prior missing-store and concurrent-reservation concerns at the source level; live DB migration/grant verification remains outstanding.

## 5. Positive controls to preserve

- Production webhook requests are refused when the webhook secret is missing.
- Secret comparison uses a length check and timing-safe comparison.
- The private Abel path checks the private chat id against TELEGRAM_ALLOWED_CHAT_ID.
- Group messages are restricted to TELEGRAM_GROUP_CHAT_ID and the owner sender id; unknown human participants are ignored.
- Private Telegram updates use durable update_id claims and make write paths read-only when the claim cannot be established.
- Forwarded-message bursts have a durable persistence/recovery design and a bounded batch size.
- Bot model spend reservations are atomic and fail closed.
- Proposal decisions through the app API are owner-only.
- Bot registry scopes, proposal-first guardrails, and the rule that approved proposals do not execute until an execution path exists should remain intact.

## 6. Recommended order

1. **BT-001:** block or correctly scope non-Abel private bot chats. This is the most important capability-boundary issue.
2. **BT-002:** decouple response identity from the webhook that happened to receive/claim the message.
3. **BT-003:** make cross-webhook dedup fail closed for side-effecting work.
4. **BT-005:** put every bot handoff through the same loop/depth guard.
5. **BT-006:** make Telegram sender identity authoritative and stop trusting prefixes for identity.
6. **BT-004:** rate-limit distinct updates, not duplicate per-face deliveries.
7. **BT-007/BT-008:** make team-wide health visible and give each unhealthy state a safe recovery path.

## 7. Required regression and live verification

Before marking a finding VERIFIED or CLOSED, attach evidence for:

1. **Private face isolation:** DM each configured bot. Verify its reply identity and exact tool list. Prove a restricted bot cannot invoke Abel's tools.
2. **Multi-webhook group delivery:** deliver the same Telegram message to Abel and Scout concurrently. Verify exactly one reply and that it comes from the bot selected by routing, not whichever webhook won.
3. **Claim failure:** simulate unique conflict, transient insert error, missing store, and DB timeout. Verify no duplicate proposals, scans, or replies.
4. **Rate limiting:** deliver one logical owner update to N bot webhooks and verify it consumes one logical-message allowance.
5. **Bot loop:** create bot-to-bot chains at depth 3, 4, and 5, including a direct Billing handoff. Verify the common cap applies.
6. **Identity spoofing:** have Scout send text prefixed as Abel, Billing, Auditor, and Watchdog. Verify Telegram sender identity remains authoritative.
7. **Per-face connection status:** check every configured bot's getMe, getWebhookInfo, allowed updates, pending count, last error, and secret configuration. Test repair without dropping pending updates.
8. **Telegram functional setup:** verify each account's group membership, privacy setting, Bot-to-Bot Communication Mode, webhook URL, and owner/group allowlists. Test actual message delivery; do not infer it from configuration alone.
9. **Operational behavior:** test Telegram retries, duplicate/late updates, process restarts, Fly multi-instance behavior, rate-limit drops, and weak-network conditions.
10. **Quality gates:** run targeted unit tests, full tests, typecheck, lint, and build on the exact commit; record commands and results. Independently verify the live Fly release and production Supabase migrations.

## 8. Claude / Muse handoff and owner governance

This report is an investigation/design handoff only.

- **Owner / product authority:** Sajacous. Owner approval is required before implementation, merge, migration, or deployment.
- **ChatGPT:** architect, independent reviewer, and acceptance authority.
- **Claude / Muse:** investigate, reproduce, and prepare design proposals when asked.

Required lifecycle:

NOT VERIFIED → VERIFIED → DESIGN REQUIRED → DESIGN APPROVED → IMPLEMENTATION → TESTING → CODE REVIEW → ACCEPTED → LIVE VERIFICATION → CLOSED

For each finding:
1. Reconfirm it against current main, with exact line references and reproduction evidence.
2. Mark it VERIFIED, NOT REPRODUCED, or NEEDS LIVE VERIFICATION.
3. Propose a minimal design with alternatives, test plan, rollout/rollback, and operational impact.
4. Stop for explicit owner approval before implementation.
5. Do not merge to main, apply production migrations, change Fly secrets, or deploy without a separate owner instruction.

**Standing constraints:** no GitHub Actions; no unapproved code changes; no production migrations or deployments; preserve owner-only approvals, least privilege, truthful audit records, and the phone-first/weak-signal driver workflow.

## 9. Disposition

**NOT ACCEPTED as a production-readiness sign-off.** The findings require verification and design review. No finding is closed by this document.

**Changes made:** documentation only, on the dedicated audit branch. No application code, migrations, production settings, Telegram registrations, or deployed services were changed.
