# Owner tracker — what's being worked on, and what's waiting on whom

The owner's request (2026-11-21): "document things that you're tackling so I can't forget."
One page, kept current by whoever is working (Claude or King). Newest at the top of each list.
`PROJECT_STATE.md` keeps the long build history; this page is the short "where are we" view.

**Rule for every agent:** when you start, finish, or block on something, update this page in the same
commit. A line here is never deleted silently: done items move to "Done recently" with the merge commit.

## In progress

| What | Who | Where | Status |
|---|---|---|---|
| Bot team Phase 2: Billing, Tracker, Watchdog, Maintenance, Auditor on the shared human turn | Claude | `docs/design/bot-team-conversation.md` §7, branch `feat/bot-team-phase2-2026-11-21` | **Built and checked; waiting on "Merge"** |
| Bot team next: scheduled autonomous work (e.g. Scout offers a scan when a load delivers); bot-to-bot messages from bots' own accounts through the shared turn | Claude | design to write | Next |

## Waiting on the owner

| What | Why it matters |
|---|---|
| Answer **NO** to Abel's pending "$400 paycheck" proposal (2026-11-21) | It would record a Nov 20 paycheck that never happened. The two $200 advances go through Abel again after deploy. |
| Deploy main (Fly web UI) | Everything below is merged but not live. |
| Screenshots of the map showing the route the opposite way from TruckPath | Needed to find that bug; still unresolved. |
| Install Tracker **1.3.0** (Settings → download; installs over 1.2.0) | Backup-off key protection, per-position retry. |

## Waiting on King (after deploy)

| What | Notes |
|---|---|
| Apply migrations in order: 00101, 00103, 00106 (corrected files), 00108–00116, 00118 | There is no 00117. Each has a pre-flight that stops without changing anything if it finds bad data. |
| Run the SQL checks in the Supabase editor | `tests/db/tenant-fk.sql`, `outbound-call-claim.sql`, `bot-spend-reservation.sql`, `business-credit-owner-only.sql` (all roll back). |
| For EVERY bot account: `TELEGRAM_<BOT>_BOT_TOKEN` (secret), `TELEGRAM_<BOT>_BOT_USERNAME`, webhook `…/api/telegram/webhook?bot=<slug>` | Owner 2026-11-20: every bot gets its own BotFather account. Then Settings → Telegram shows each bot's card. |
| `TELEGRAM_GROUP_CHAT_ID`, BotFather privacy OFF + Bot-to-Bot Mode ON for every bot | Without these the bots can't hear the group or each other. |
| `ELEVENLABS_API_KEY` as a Fly secret | The owner's voice for spoken lines. |

## Done recently (merged to main, not yet deployed)

- 2026-11-21 Bot team Phase 1: every bot understands any wording and talks like a person (`c2cb931`).
- 2026-11-21 Abel records cash advances out of the right paycheck (`199af7b`).
- 2026-11-20 Bots & Telegram audit fixes BT-001..008, every bot on its own account (`47a89bf`).
- 2026-11-20 Full-repository audit batches 1–3: call guards, spend cap, tenant keys, GPS accuracy, Tracker 1.3.0, Business Credit owner-only, call state machine (`6aa19c9`, `b37e3ec`).
- 2026-11-20 Owner's Telegram chat id removed from the public repo files (`f98106e`).
