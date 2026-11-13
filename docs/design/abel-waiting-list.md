# Abel: the waiting list (answers, corrections, plain words)

Status: built on `fix/abel-pending-answers`, 2026-11-12. Owner instruction: "Fix it properly make it better and actually work",
after a chat transcript from 2026-11-11/12. No migration, no API contract change. Names and figures below are fictional.

Follow-up: Telegram review fix, built 2026-11-12 on `feat/telegram-review-fixes-2026-11-12` (record:
`~/workspace/builds/gates/telegram-review-2026-11-12.md`). Migration 00093 (`telegram_dead_letters`) authored, NOT applied —
apply before deploy. Guard test: `tests/unit/services/bot/telegram-review-guard.test.ts` replays the exact transcript.

## What went wrong (from the transcript)

1. Four proposals were waiting. A plain "Yes" got the same long list back, twice.
2. He then answered each one ("1. Yes 2. Yes 3. It's active not complete 4. Not sure, no"). That reply went to the model,
   which ignored 1-3 and reported doing item 4, the one he declined.
3. A correction to a forwarded trip that was still waiting ("the trailer number is actually ...") was treated as an edit to a
   saved load. The trip was not saved yet, so the bot said it could not find it, then offered a different load.
4. Forwarding the same trip again left two copies waiting; a later yes could create the load twice.
5. Waiting items were shown with record ids, column names, file names and UTC timestamps, and one item repeated its stops
   three times.
6. "How are you" was answered with a notice about an expired photo question.
7. Abel said "I'll pause it" about a proposal — but no pause state exists, so the complete-load proposal reappeared twice,
   and a duty proposal from Nov 8 rendered on Nov 11 despite the 2-hour expiry.
8. A days-old location fix could drive a fresh duty proposal, presenting a stale timestamp as current.
9. The model executed a pending write mid-turn (the duty write he had answered "not sure, no" to) instead of waiting.

## Rules

- Everything proposed and not yet answered is ONE numbered list. A batch (a forwarded trip with its photos) is one entry.
- His reply to that list is read in code (`src/services/bot/waiting-list.ts`, `parseWaitingAnswers`), never by the model:
  - `1. yes 2. no`, `1 yes, 2 no`, `yes to 1 and 2`, `drop 4`, `yes all`, `drop all`.
  - A yes must be the whole answer for that number. Any plain "no" clause makes it a no ("not sure, no").
  - Anything else after a number is a comment: the item is left waiting, untouched, and his words are quoted back.
  - A number that is not on the list voids the whole reply; nothing is guessed.
  - An item answered no is cleared and can never run. Items he did not mention are untouched.
- A bare yes/no with several items waiting does not say which, so it gets the short list once, with how to answer.
- A comment that CONTRADICTS the proposal IS a no (review fix, `commentContradicts` in `waiting-list.ts`): "not complete" /
  "still active" against a complete-load proposal, or a different duty status named against a duty proposal. The proposal
  is dropped for good — declined is terminal, it never renders again. A comment that does not contradict leaves the item
  waiting, quoted back. There is no "pause" state and Abel never says "pause" — an item is waiting until he answers, or
  dropped.
- Freshness (review fix): a location fix older than 15 minutes never drives a duty proposal; the reply says "I don't have
  a fresh location — last fix [age]" and stages nothing. A feed gap restarts the motion episode, so a stop from before the
  gap cannot drive a proposal on arrival. An identical duty proposal is never re-staged while one is already waiting.
  (Root cause of the Nov 8 proposal rendering on Nov 11: re-staging, not unenforced expiry — live-location staged
  directly via `savePendingAction`, bypassing proposal reconciliation. Expiry was already enforced at render.)
- Model-execute guard (review fix): a write the model tries to execute immediately while the identical write (same tool +
  arguments) is already waiting for his yes is refused in the loop (`isWriteAlreadyPending` on the agent-loop input,
  wired in `agent-turn.ts` to the live pending rows). A guard-check failure never blocks a write.
- Persist failures (review fix, D12): a message save retries once, then writes a dead-letter row (`telegram_dead_letters`,
  migration 00093), then throws; a pending-burst save retries once, then dead-letters and stays best-effort. A failed
  turn persist also sends him one line: "I couldn't save that to your record — still done, just not stored". A dead
  letter is evidence for a human to re-file, never auto-replayed.
- Numbers refer to the list when the list was the last thing Abel showed, or when the newest proposal is older than
  10 minutes. Otherwise the existing rules stand: a bare yes answers the proposal just shown, and batch item numbers work
  as before.
- Corrections: every turn that reaches the model carries every waiting item with its pending id, and the rule that a waiting
  trip has no saved record yet. `revise_pending_item` takes `pending_id` (any waiting item, not only the newest) and
  `drop: true` (he said the item is wrong altogether). A revision is still not recorded until he approves it.
- Forwarding a trip whose create proposal is still waiting replaces that copy (and what was bundled with it).
- Display (`plainSummary`): times on the clock they were written on (an appointment marked Central stays Central), otherwise
  the truck's zone; never UTC. No record ids, column names or photo file names. Stored summaries and arguments are unchanged.
- An expired photo question is dropped quietly unless his message was answering it.

## Not in this change

- Pay answers with real figures, fewer/shorter hours alerts, and reading his free-text note on a forwarded trip are prompt
  rules only here (`PLAIN_TALK_RULES`); they need their own work and tests.
- The wrong trailer number read from a photo and a garbled broker name are reading errors, not handled here beyond making
  the correction land.
- Quote resolution (replying to a message to answer the proposal it quoted) is still absent from the Telegram code — the
  review's D4. Left open for a follow-up design.
