# Abel: readable messages, safe changes, no redundant approvals (design)

Owner feedback 2026-11-07 (voice, from live use). Status: sections 1-5, 7 and 8 BUILT; section 6 is a proposal awaiting the owner's decision (machine learning),
and the rest of section 8 is the temporal-reasoning roadmap.

## 1. Readable Telegram messages (no stars)
Telegram shows plain text, so the model's markdown (`**bold**`, `* bullets`, `# headings`) appeared as literal
asterisks. Two layers, because a prompt alone is not a guarantee:
- **Prompt style rules** (one shared block): plain text only, never asterisks/underscores/pound signs for style;
  a short emoji header per message that says what it is about; one fact per line, `emoji Label: value`; blank
  line between groups; short lines (read on a phone in a truck).
- **Code formatter** (`services/telegram/format-reply.ts`, idempotent, applied to every outgoing text and before the
  turn is stored, so the model also sees clean history): strips markdown markers, turns bullet markers into a
  topic emoji, turns markdown headings into an emoji header, and adds a topic emoji to bare `Label: value` lines
  (Load, Pay, Fuel, Miles, Date, ...). It never alters digits, dollar amounts, ids, URLs or words.
- Code-built blocks (proposals, "Done", "Still waiting", batch lists) use the same emoji vocabulary.

## 2. A change may never silently zero his pay (root cause + guards)
Root cause found 2026-11-07: `set_pay_pin` replaced the whole pay structure and carried over every field EXCEPT the
rate (`rate: parsed.rate ?? null`). Telling Abel "I don't pay for fuel" made it update the fuel field with no rate,
so the new pin had no rate and pay computed to zero.
- `set_pay_pin`: `model` and `rate` are now carried over from the current pin when not given (same model);
  switching to a model that needs a rate without giving one is refused, not nulled; a rate of 0 is refused.
  The proposal shows before -> after for every field it changes.
- `set_pay_terms`: an explicit rate of 0 is refused unless a percent of the load is set; the proposal shows
  before -> after and warns when pay would drop.
- Every record update: a numeric field (money, miles) going from a positive value to 0 or empty is called out in
  the proposal ("sets rate to $0.00 (was $2,000.00)") so he sees it before approving.
- Prompt rule: stating WHO PAYS FUEL changes only `fuel_paid_by`; it is never a reason to touch a rate or miles.

## 3. No redundant approvals
Before any proposal is staged, code reconciles it with the proposals already waiting and with the other proposals in
the same turn (same tool + same target record/employer):
- identical to one already waiting -> not staged again ("already waiting for your yes");
- same target, different values -> the OLDER waiting proposal is replaced by the newer (the reply says so), and
  within one turn updates to the same record are MERGED into one proposal (later values win);
- different targets -> unchanged.

## 4. Saying where it was saved
Two different ways Abel keeps things, now named in every confirmation:
- 💾 **Saved to your app** - a real record (a load, an expense, pay terms...) with the page where he finds it.
- 🧠 **Remembered** - Abel's own notes/learned facts. Not an app record; it shapes later answers only.

## 5. Tools
The write tools cover loads, expenses, fuel, maintenance, people, documents, threads, pay terms and pay pins.
Gaps found so far are listed in the work queue as found; none are added speculatively.

## 6. "Machine learning" - proposal for the owner's decision
Honest scope: training a model is neither needed nor free-first for one driver. What he actually wants is an
assistant that learns his preferences from his corrections. Feasible, in order:
1. **Outcome log** (needs one small migration): every proposal's fate - approved, dropped, corrected, expired -
   with the tool and a plain summary. This is the raw material for any learning and also feeds item 3.
2. **Lessons from corrections**: when he corrects or rejects the same kind of proposal repeatedly, Abel proposes a
   remembered fact ("Fuel is never on his card - never propose a fuel expense") he approves once.
3. **Risk scoring**: proposals that resemble previously rejected ones get flagged before being shown.
Nothing here changes authority: Abel still proposes, he approves. Not built until the owner chooses.

## 6b. The owner's capability list (2026-11-07, in his order)
1. Smarter - fewer redundant or wrong proposals, safer changes (sections 2-3, built).
2. Machine learning - learns from his approvals and corrections (section 6, awaiting his go-ahead).
3. **Temporal reasoning** - understands time: relative dates, ordering, durations, deadlines, staleness (section 8).

## 7. Personality: emoji, stickers, reactions (owner 2026-11-07)
"Use memes and emojis, whatever is accessible in the Telegram keyboard." What a bot CAN use, free and without keys:
- **Emoji** in text - already the house style (section 1), used freely.
- **Stickers** - Abel can send one by emoji (`{{sticker:🎉}}` in its reply; code strips the marker and sends it). The sticker
  comes from a public sticker set looked up at run time with `getStickerSet` (`TELEGRAM_STICKER_SET`, default Telegram's own
  `AnimatedEmojies`); no set / no match / any failure = nothing extra is sent, never an error.
- **Reactions** on his message (`{{react:👍}}`) from Telegram's standard reaction list.
- **Incoming** stickers, GIFs and bare emoji now reach Abel as `[sticker 😂]` / `[GIF]` instead of the "I only work with text"
  reply; they are never commands (a sticker cannot approve a proposal).
Taste is enforced in code, not just the prompt: at most one sticker and one reaction per reply; none on any message that
carries a warning, an error, a failure or an approval request (⚠️ ❌ "NOT recorded" "Reply YES" ...). Wins, good news, friendly
banter only.
Not built: GIF/meme search (Tenor/Giphy) - needs an API key, content moderation and an owner choice of provider; proposed
as optional later. Telegram's keyboard stickers/GIFs are the user's own to send - a bot can only send what it fetches.

## 8. Temporal reasoning (owner 2026-11-07)
First slice BUILT: Abel never does date math in its head. Two read tools compute it in code from "today" on the owner's
clock (America/New_York): `when_is` (today / tomorrow / yesterday, "friday", "next friday", "last friday", "in 3 weeks",
"10 days ago", "the 6th", "nov 6", "11/6", ISO dates, start/end of this/next/last week) and `time_between` (calendar days,
weeks + days, weekdays between). Ambiguous phrases say which reading was used and give the other candidate.
Roadmap (not built): event timelines ("what happened since Tuesday"), staleness - facts and statuses carry an age and Abel
says "as of Tuesday" instead of asserting old state, deadline awareness (docs due, reminders), sequencing of loads on a calendar,
and pay-period reasoning shared with the pay-week logic.

