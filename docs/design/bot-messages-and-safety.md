# Abel: readable messages, safe changes, no redundant approvals (design)

Owner feedback 2026-11-07 (voice, from live use). Status: all sections BUILT (owner approved everything on 2026-11-07: machine learning, the full temporal-reasoning
list, and GIF memes).

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

## 6. Learning from his answers ("machine learning", approved 2026-11-07)
Honest scope: no model is trained - one driver's data does not need it, and it would not be free-first. What "learning" means
here is an assistant that measurably changes its behaviour from how HE answers it, with every step visible and reversible:
1. **Outcome log** (migration 00076, `bot_proposal_outcomes`): the fate of every proposal - approved, dropped, corrected,
   expired, failed, replaced (by a newer one) - with the tool, a signature (tool + category/kind), the plain summary and the
   args. Written best-effort: a missing table or a failed write never affects the conversation.
2. **Statistics in code** (`bot/learning.ts`, pure): per signature, approvals vs drops/corrections over the last 90 days,
   recency-weighted. Stats are computed, never model-written, and are shown to the model as a "WHAT HE HAS TOLD ME BY ANSWERING"
   block so it adapts (suggest less of what he keeps dropping, lead with what he keeps approving).
3. **Lessons he approves**: when a signature crosses a threshold (>= 3 answers, drop-or-correct rate >= 75% or approval >= 90%),
   a lesson is READY ("he usually drops fuel expenses - only propose them when he asks"). Abel proposes it as a memory with the
   normal yes/no; nothing becomes a remembered fact without his approval. An existing lesson is never proposed twice.
4. **Risk flag**: a new proposal whose signature he has mostly dropped carries a visible line ("🤔 you've dropped 4 of the last 5
   suggestions like this") so a likely-wrong suggestion is questioned before he has to.
5. `learning_report` read tool: "how has it gone?" answered from the log.
Nothing changes authority: Abel still proposes and he approves. The log is his data, tenant-scoped like everything else.

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
- **GIF memes** (`{{gif:search words}}`): looked up on Tenor (free API key, `TENOR_API_KEY`; medium content filter, safe-for-work
  by default) and sent with `sendAnimation`. Same taste rules and caps as stickers (one flair of each kind per reply, none on
  serious messages). Without the key the feature is simply off - Abel falls back to emoji and stickers. The key is a runtime secret
  held only in the server's environment, like the bot token.
Telegram's own keyboard stickers/GIFs are the user's to send - a bot can only send what it fetches.

## 8. Temporal reasoning (owner 2026-11-07, all of it approved)
Abel never does date math in its head; everything below is computed in code on his clock (America/New_York).
1. **Date phrases and spans** (`lib/temporal.ts`, tools `when_is`, `time_between`): weekdays, "next friday", "in 3 weeks", "the 6th"
   (nearest occurrence, other reading named), month names, slash dates, week edges, day counts, weekdays between; unreadable input
   is refused. **Pay-period phrases** share the pay-week logic: "payday", "next payday", "statement day", "end of the pay week",
   "last pay week" resolve from his saved pay terms (never hardcoded; unset = said so).
2. **Event timelines** (`timeline` tool, `bot/timeline.ts`): "what happened since Tuesday / last week / between X and Y" - loads
   (picked up, delivered), expenses, fuel, maintenance, documents filed and duty-status changes, merged and ordered by day
   with the weekday, optionally filtered by topic.
3. **Staleness** (`lib/staleness.ts`): remembered facts carry their age in Abel's context ("noted Oct 20 - 18 days ago"), and a
   time-bound fact ("this week", "today", "currently", "active") older than a day is flagged as possibly out of date, so Abel says
   "as of Tuesday" rather than asserting old state as current.
4. **Deadlines** (`whats_due` tool, `bot/deadlines.ts`): one list of what is coming up or overdue, soonest first, with days left -
   credentials expiring, recurring bills, maintenance due by date, and the appointment windows / dates of his booked loads.
5. **Calendar sequencing** (`load_calendar` tool, `lib/load-sequence.ts`): his booked loads in order with the gaps between them
   and flagged problems - overlaps (the next pickup is before the last delivery), same-day turnarounds, long idle gaps, loads
   with no dates.
