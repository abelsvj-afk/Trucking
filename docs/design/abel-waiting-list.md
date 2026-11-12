# Abel: the waiting list (answers, corrections, plain words)

Status: built on `fix/abel-pending-answers`, 2026-11-12. Owner instruction: "Fix it properly make it better and actually work",
after a chat transcript from 2026-11-11/12. No migration, no API contract change. Names and figures below are fictional.

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

## Rules

- Everything proposed and not yet answered is ONE numbered list. A batch (a forwarded trip with its photos) is one entry.
- His reply to that list is read in code (`src/services/bot/waiting-list.ts`, `parseWaitingAnswers`), never by the model:
  - `1. yes 2. no`, `1 yes, 2 no`, `yes to 1 and 2`, `drop 4`, `yes all`, `drop all`.
  - A yes must be the whole answer for that number. Any plain "no" clause makes it a no ("not sure, no").
  - Anything else after a number is a comment: the item is left waiting, untouched, and his words are quoted back.
  - A number that is not on the list voids the whole reply; nothing is guessed.
  - An item answered no is cleared and can never run. Items he did not mention are untouched.
- A bare yes/no with several items waiting does not say which, so it gets the short list once, with how to answer.
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
- Why a duty entry dated 2026-11-08 was still being offered on 2026-11-11 needs the live records.
