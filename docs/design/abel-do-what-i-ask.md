# Abel: do what I ask

Status: approved by the owner 2026-11-16 ("Go" on items 1-3). Branch `feat/abel-do-what-i-ask`.

Owner, 2026-11-16: "It should be able to do whatever I ask." His chats showed that Abel's failures were mostly not
missing reasoning. Common requests depended on the model happening to pick the right tool, and a request with no tool
behind it ended in a vague answer or nothing.

## 1. Never a dead end: the "can't do that yet" list

- New tool `note_capability_gap` (immediate, writes no business record): when he asks for something no tool can do,
  Abel calls it with his words and what is missing, then tells him plainly. It never pretends, and never offers a
  different thing in its place without saying so.
- Storage: table `abel_capability_gaps` (migration 00096). The same ask again bumps `times_asked` instead of adding
  a row.
- Interface: the app page **More → What Abel can't do yet** lists the open gaps, newest first, with how many times he
  asked. He can mark one "drop it". That is the build backlog, in his words.
- Before migration 00096 is applied, the write fails quietly (logged) and Abel still tells him what it can't do.

## 2. Everyday asks answered in code

Answered in code before the model, read-only, each also left to the model when the code can't read the data:
- "how many hours do I have / what are my hours": the hours clocks from his log (planning only, not an ELD).
- "what's waiting on me / what's pending": the numbered waiting list (same as a bare yes with several waiting).
- "where's my next load / what's my next load": his next confirmed load by pickup date.

## 3. Correcting a value read from a photo

When he corrects a trailer number Abel read from a photo while a trip with it is waiting, the correction goes through
`revise_pending_item` on that trip. The prompt now names the photo-read trailer case explicitly. (A photo-read value is
never written to a saved record without his yes, so there is nothing else to change.)

## 4. Telling Abel your status lines up the log entry (added 2026-11-16, owner: "Continue making Abel smarter")

"I'm off duty for 19 minutes so far" got "Thanks for the update!" and nothing logged. Now a first-person present
statement of duty status ("I'm off duty", "been driving 2 hours", "just went on duty", "I'm in the sleeper",
`src/services/bot/status-talk.ts`) is read in code:
- the start time is worked out from what he said (19 minutes ago; "now" when no duration; durations over 14 h are
  ignored as not a status statement about the current period);
- if his log already shows that status, Abel says so and stages nothing;
- otherwise ONE `log_duty_status` proposal is staged for his yes (paper-log helper, not the ELD). Nothing is logged
  without his yes, and he can answer with the right time instead.
- Questions ("am I off duty?"), plans ("I'll be off duty at 5"), negations, bare words ("off duty", which may be an
  answer to something else) and longer messages are left to the model.

## 5. His note sent with a trip sticks to the load (added 2026-11-16)

In the chat, he sent "the trailer is empty, not sure yet if I'm dropping and hooking" together with Trip 1903, and it
was ignored. Now what he types himself in the same burst as a forwarded or pasted trip rides the new load as its
`notes`, in his words, in the same yes. The review says "📝 Your note goes on the load: ...". A bare yes/no is never
treated as a note. `list_loads` now returns each load's trip number and his note, so Abel can bring the note up
when he asks about the trip later.
