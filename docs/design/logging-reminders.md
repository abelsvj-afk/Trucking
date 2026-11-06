# Proactive logging reminders — design (BUILT 2026-11-05; migration 00065)

Status: owner asked for the design and answered "yes to all that needs a yes" (2026-11-05); the choices below are the defaults I proposed, built as written. Closes decision D-4 (reminders half); the Home map card (HUD §8) stays unbuilt and unscheduled.

## 1. What and why
Abel today answers only when asked, except for research alerts, the weekly pay report, maintenance digests and Live Location status *proposals*. HUD §7 promised that he can remind the owner to log. This adds the smallest useful version: two reminders, both **informing or asking, never acting** (no status is ever changed, nothing is booked).

## 2. The two reminders
| Kind | Trigger (from his own logged duty rows) | Delivery |
|---|---|---|
| **hos** | While logged *Driving* or *On duty* (and not yet rested 10 h): the 11-hour driving clock, the 14-hour window, or — only while driving — the 30-minute-break clock reaches **30, 10, or 0 minutes** left. The tightest threshold reached is sent. | **Immediate**, day or night. Quiet hours do not hold a safety warning. |
| **stale_status** | The latest *Driving*/*On duty* status has stood **more than 14 hours** — longer than a duty window can run — so the log is probably out of date. | **Routine**: waits for quiet hours (21:00–06:00 ET) to end. |

Wording always says it is *based on his logged hours — planning only, not an ELD.* The stale-status message asks him to tell Abel the right status and when it changed, and says Abel will ask before changing anything.

## 3. Rules
- **Switch:** capability `logging_reminders`, **off until he turns it on** in Settings (no row = off, like every proactive capability). The global switch also stops it.
- **Once only:** each reminder has a dedupe key (clock + threshold + the window's start; or the status start). The key row (`reminder_sends`, migration 00065) is inserted **before** sending; a failed send deletes it so the next tick retries; a missing/unreadable table sends **nothing** (no spam).
- **Cadence:** a check every 5 minutes (in-process, like the other schedulers); all reminders due at once go in one message, safety lines first.
- **Recipient:** the owner's Telegram chat only.
- **No driving nag beyond safety:** routine reminders are not sent in quiet hours; safety warnings are sent even while driving (they are the point).
- **Not included (deliberately):** cycle (70/8) warnings (day-level, the Hours page already shows them), "you forgot to log today" nudges (needs a definition of "today's expected log" he hasn't given), reminders based on GPS (Live Location already stages status *proposals*).

## 4. Honesty and failure modes
Clocks are computed by the same engine as Home (`lib/hud-clocks`) from the rows he logged; if he hasn't logged, nothing fires and nothing is invented. Provisional carrier settings are the same ones Home labels as provisional. If the HOS window can't be loaded, the tick logs and sends nothing.

## 5. Where
`lib/reminders.ts` (pure), `services/bot/reminder-scheduler.ts`, migration `00065_reminder_sends.sql`, Settings label, tests `reminders.test.ts` and `reminder-scheduler.test.ts`.

## 6. Open (owner)
Thresholds (30/10/0) and the 14-hour stale rule are proposals he can change; whether to add a "no log by 10:00 ET" morning nudge once he defines what a normal day's log looks like.

## Update 2026-11-06 (Block B, `docs/design/driver-hud-round2.md`)
HOS reminders now fire at **2 h, 1 h, 30 min and expiry** (was 30/10/0) for all four clocks - drive, 14-hour window, 30-minute break and the 70/8 (or 60/7) cycle (the scheduler passes the server's cycle summary from the one HOS read). One message per threshold per clock per shift: the key is `hos:<clock>:<threshold>:<shift>` where the shift is the window start (drive/window/break) or the carrier period start (cycle). Each message states the consequence and the action in plain words and is still labeled planning-only, not an ELD. They stay critical: sent immediately, even in quiet hours, at those thresholds only. The 14-hour window is announced on any non-rested status (it never pauses) until it ends; the other clocks only while he is working. Ring colours use the same thresholds (amber <= 2 h, red <= 30 min, EXPIRED at zero) from the same `computeHudClocks` read, and a test asserts the colour and the notification never disagree.
