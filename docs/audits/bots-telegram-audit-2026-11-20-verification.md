# Bots & Telegram audit — verification (2026-11-20)

Audit: `docs/audits/bots-telegram-audit-2026-11-20.md` (audit branch commit `03b2007`, base `6aa19c9`).
Re-checked against main `f98106e`. Source verification only: no live Telegram, BotFather or Fly checks
(those stay with King). Lines are from main `f98106e`.

| ID | Status | Evidence | Severity note |
|---|---|---|---|
| BT-001 | **VERIFIED** | `telegram/webhook/route.ts:208-209`: `?bot=` is read only inside the group branch; a private update to any face falls through to the 1:1 Abel path (full private tool catalog, replies sent with Abel's token). | The 1:1 path still requires `TELEGRAM_ALLOWED_CHAT_ID`, so only the **owner** can reach it — no third party gets Abel's tools. Real problem: a DM to Scout is answered by Abel with Abel's full tools (and the reply lands in Abel's chat). P2, not P1. |
| BT-002 | **VERIFIED** | `route.ts:215,249,255`: `groupBotToken` = the RECEIVING face's token, and it is the generic `sendMessage`. Whichever webhook wins the claim (`group.ts:561`) answers Abel/Billing/proposal acks under its own face. `sendAsBot` (`route.ts:265`) falls back to Abel's token for everyone but the Auditor. | P1 for correctness: replies can come from the wrong bot. |
| BT-003 | **VERIFIED** | `group.ts:318-326`: any non-duplicate error in `claimRoomMessage` returns `true` (proceed); `group.ts:560`: no store = no claim at all. | P1/P2 as stated. |
| BT-004 | **VERIFIED** | `route.ts:167-171`: rate limit keyed by chat + kind runs BEFORE group dedup; every face's copy counts. | P2 as stated. |
| BT-005 | **VERIFIED** | `group.ts:468-506`: the Billing handoff branch claims and runs `handleBillingGroupTurn` and returns before `botChainDepth` (`:531`) and `evaluateBotPickup` (`:592`). | P2 as stated. |
| BT-006 | **VERIFIED** | `group.ts:462,479`: `parseRoomSpeaker(botText)` overrides `fromBotSlug` (`if (speaker !== null) fromBotSlug = speaker`) even when the Telegram account was identified. | P2 as stated. |
| BT-007 | **VERIFIED** | `webhook-admin.ts:118-121`: report/repair use the one primary `botToken`; the Settings card shows one status. | P2 as stated. |
| BT-008 | **VERIFIED** | `TelegramConnectionSettings.tsx:65`: the only action is "Fix the connection" for missing update types; a missing secret, a delivery error or no webhook show "Needs attention" with no next step. | P2 as stated. |

## Proposed fixes (minimal; each needs the owner's yes)

1. **BT-002 — reply identity follows the RESPONDING bot.** One `sendAs(botSlug, chatId, text)` in the route that picks that bot's own token from `BOT_FACES` (fallback: Abel's token with the "Name:" prefix, as today). The group handler sends every reply through it, never through the receiving face's token. Test: the same update delivered to Abel's and Scout's webhooks → exactly one reply, from the routed bot.
2. **BT-003 — fail closed.** A claim that cannot be established (store missing or a non-duplicate error) means no side-effecting turn: no model call, scan, proposal or handoff. The owner gets one plain line ("I couldn't log that message, so I didn't act on it — send it again in a moment"), sent only from Abel's webhook so it is said once. Tests: duplicate, transient error, missing store, two concurrent deliveries.
3. **BT-001 — private face chats.** Recommended now: a private update on a `?bot=` webhook other than Abel's gets one honest line from that bot ("Talk to me in the team group — Abel handles 1:1") and nothing else. No tools run. A real per-bot 1:1 with that bot's tool scope can be designed later. Test: a private DM to Scout runs no agent turn.
4. **BT-005 — one gate for every bot turn.** The Billing handoff goes through the same message-id dedup, chain depth and pickup verdict as every other bot message (moving it below those checks). Test: a chain at the cap that addresses Billing gets no Billing turn.
5. **BT-006 — the Telegram account wins.** When the sender's account is a known face, the text prefix never changes who spoke; the prefix is used only for the shared-account fallback (no username). One registry: `BOT_FACES` gains the username, and `identifyTeamBot` reads it. Test: Scout's account sending "Billing: …" is still Scout.
6. **BT-004 — count messages, not copies.** Group updates are rate-limited AFTER the claim (only the delivery that won counts); private and location keep the current limiter. Test: one update to three webhooks uses one allowance.
7. **BT-007/BT-008 — team-wide health.** Settings → Telegram lists every configured face (token set yes/no, `getMe` name, webhook host, allowed updates, pending count, last error; never a token). Each unhealthy state gets its own next step: in-app repair where the existing URL allows it, otherwise the exact thing King must set. No generic button for a state it can't fix.

Order: 2, 3, 1, 5, 6, 4, 7 (the reply-identity and duplicate fixes first, because both change what the owner sees in the group today).

## For King (live)

- For each face: `getMe`, `getWebhookInfo` (URL includes `?bot=<slug>`, allowed updates, pending count, last error), group membership, privacy mode, Bot-to-Bot Communication Mode.
- One real owner message in the group: count the replies and note which account sent each one.
