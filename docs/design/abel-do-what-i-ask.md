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
