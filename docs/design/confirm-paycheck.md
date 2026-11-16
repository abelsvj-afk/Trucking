# Confirming a paycheck (in the app and by telling Abel)

Status: owner decisions 2026-11-16. Branch `feat/confirm-paycheck`.

Owner: "I'm not able to confirm paychecks. I've already got my paychecks, yet they still show unconfirmed in the app."
Before this, a paycheck counted as received only when a settlement statement was recorded with a pay line per load.
No screen offered that, so every paycheck stayed "not paid yet" forever.

## Owner decisions

- **Amount:** what hit his bank (the take-home deposit). He can also attach his pay statement.
- **Scope:** one confirmation covers the whole paycheck (one payday's pay week), not load by load.

## Behaviour

- **In the app** (Money → Paychecks): each payday that has finished loads gets **"I got paid"**. The amount box is
  pre-filled with the expected take-home (the low end when the expectation is a range), so a normal week is one tap.
  He can change it, and optionally attach his statement (a photo or PDF; filed as a `settlement` document on one of
  that paycheck's loads). A confirmed paycheck shows "Paid $X on <date>" with **Undo**.
- **By telling Abel** ("I got paid $1,234.56 today", "my check came in"): tool `confirm_paycheck`, a proposal for his
  yes like every other write. Abel names the payday and the amount back before the yes. A statement photo still goes
  through the existing `extract_settlement` path.
- **What a confirmation does to the picture** (`applyPaycheckConfirmations`, one place, read by the page and by Abel):
  the payday's received amount becomes the deposit he confirmed. If it is at or above the expected take-home (low end),
  the paycheck is **paid**: nothing is "not paid yet" or overdue in it. If it is below, it is **short by** the
  difference, with the figures shown, so he can ask his carrier.
  Recorded settlement lines are unchanged and still count when there is no confirmation.
- Nothing about how expected pay is calculated changes. The confirmation is his word for what landed.

## Storage

Table `paycheck_confirmations` (migration 00097): `period_start`, `period_end`, `payday`, `received_cents`, optional
`statement_document_id`, `source` (app | abel), `confirmed_at`, soft delete (Undo). One live confirmation per
`period_start`; confirming again replaces it. Before 00097 is applied, the picture reads as before (no confirmations),
and the confirm action says the update is not applied yet.
