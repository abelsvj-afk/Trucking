# CLAUDE BRIEF — Telegram trip parsing, burst linking, and reference resolution (2026-11-09)

Owner order (2026-11-09, verbatim sense): fix whatever made Abel pull the
details wrong from a forwarded dispatch message that was literally copy-pasted
text; when he forwards two things together (a photo and load information) Abel
must treat them as one package and attach them to each other; Abel must be
smart — remember the conversation thread, resolve references the way the owner
says them ("this load 1874", a detail of a load) to the right record in the
database, and connect numbers pulled from one forwarded item to the items
forwarded with it.

King diagnosed all three failures against current main (15f36607). The root
causes are in code, not in the owner's messages. Do not re-diagnose from
scratch; verify against the evidence below, then build.

---

## What actually happened (Trip 1874, 2026-11-09)

The owner forwarded dispatch's assignment for Trip 1874 (ITS Logistics LLC,
ref 5113964) plus a trailer photo. The text has THREE stop blocks:

1. STOP 1 — PICKUP, Kontoor Panama City, 1 Seaport Drive, Panama City, FL
   32401, appt 11/10/2026 08:00–16:00 CST
2. STOP 2 — DELIVERY, Kontoor Seminole, 1400 Wrangler Boulevard West,
   Seminole, OK 74868, appt 11/12/2026 12:00 CST
3. A third block headed **"LOT TO"** (no "STOP n" header) — Kontoor Panama
   City, appt 11/16/2026 12:00 CST, TYPE: Delivery Stop

Abel's review showed only two stops — Stop 2 as "DELIVERY: Kontoor Panama
City … 11/16/2026" — and on the owner's yes created load
`50dde25b-6aed-42e5-b63f-fffa64fd7b56` as Panama City, FL → Panama City, FL
with 2 stops. **Seminole was silently erased.** The photo (read correctly:
"TRAILER # H11887 / PICKUP # 94405") was stored unattached. When the owner
then said "attach it to the only truck … and to this load 1874", Abel
proposed attaching it to the OLD load `0df2759d-…` (Savannah, GA → Seminole,
OK, completed 2026-11-05) plus an unrelated "clear the pay override"
proposal. The owner said No. Later Abel also emitted a raw tool error about
a vehicle-defect id that did not exist.

## Root cause 1 — the deterministic trip parser overwrites a stop (P0)

`src/lib/dispatch-trip.ts`, `parseDispatchTrip`: a new stop block starts
ONLY on a line matching `^STOP\s+\d+`. The "LOT TO" header matches nothing
(no colon, not a STOP header, not TRIP DETAILS), so the loop keeps writing
into `cur` — still Stop 2 — and the block's SHIPPER/CONSIGNEE, ADDRESS and
APPT lines **overwrite Seminole's name, address and appointment field by
field**. No guard, no warning. King reproduced this exactly with a faithful
port of the parser over the real Trip 1874 text: output = 2 stops, Stop 2 =
Panama City 11/16. This matches Abel's wrong review word for word.

Remember the design context: for this message shape the parse is done by
CODE on purpose (`stage-recordables.ts`: "A structured trip assignment is
read by CODE, not by the model", and the parsed create_load REPLACES any
create_load the model proposed). So the AI never got the chance to read the
stops — the parser mangled them first and the review (`tripReview`) rendered
the mangled parse confidently. The existing tests
(`tests/unit/lib/dispatch-trip.test.ts`) only fixture STOP-numbered blocks,
which is why this survived.

### Fix requirements (parser)

1. **A stop block ends at ANY new section header, not just `STOP n`.** Treat
   a short, colon-less, all-caps-ish header line (e.g. `LOT TO`, `DROP AT`,
   `RETURN TO`, or any line that is not a KEY: value line and not a
   separator) as the start of a new block when the current block already has
   content. Keep the header text on the stop (e.g. a `header` field) so the
   review can show "LOT TO" as dispatch wrote it.
2. **No silent overwrite, ever.** If a KEY (SHIPPER/CONSIGNEE, ADDRESS,
   APPT, TYPE) arrives for a stop block that already has that field set,
   that is a new block (start one) — or at absolute minimum a parse warning.
   A field of a parsed stop must never be replaced without the owner seeing
   it.
3. **Cross-check the parse against the raw text before staging.** Count
   stop-like blocks in the source (STOP n headers + recognized unnumbered
   leg headers + SHIPPER/CONSIGNEE occurrences) and require it to equal
   `stops.length`. Every facility name / city-state that appears in a
   SHIPPER/CONSIGNEE block must appear in exactly one parsed stop. If the
   check fails, DO NOT stage the trip as high-confidence: either fall back
   to the model extraction for the stops, or stage it with a plain-language
   warning naming what didn't line up ("the message mentions Seminole, OK
   but I couldn't place it in a stop — check before yes"). Failing loudly
   is the requirement; guessing silently is the bug.
4. **LOT TO legs:** the lot-to block becomes its own stop (seq 3). The
   freight delivery is Seminole (stop 2): `tripToCreateLoadArgs` must set
   the load's headline `destination` / `delivery_date` /
   `delivery_window_start` from the freight delivery — the delivery stop
   that ends the loaded leg — not from a later lot/drop/return leg. Rule of
   thumb to implement: a stop whose header is a lot/drop/return header
   (`LOT TO`, `DROP`, `RETURN`, `EMPTY TO`, …) is recorded as a stop but
   never chosen as the headline destination when a real delivery stop
   exists. Its TYPE line is preserved in the stop record as written.
5. **Appointment windows:** `APPT: 11/10/2026 08:00 CST-11/10/2026 16:00
   CST` currently keeps only the start. Parse the range end into the stop
   and map it to `pickup_window_end` / `delivery_window_end` in
   `tripToCreateLoadArgs` (the create_load fields exist; the trip path
   never sets them).
6. **Miles consistency:** if printed TOTAL ≠ deadhead + loaded (Trip 1874:
   1,178.27 printed vs 1,111.27 sum), keep all three figures as printed but
   add one line to the review: "Heads up: the miles don't add up in the
   message itself (deadhead + loaded = X, total printed = Y)." Never
   silently pick one.

## Root cause 2 — photos can never join the burst (P0)

The burst collector is text-only: `TelegramBurstItem`
(`src/services/telegram/burst.ts`) has only text fields, and in
`dispatch-bot.ts` a photo message is handled immediately by the photo path
("a photo message is document intake, not conversation", returns
`photo_replied`) before any burst logic. Photo intake
(`photo-intake.ts`) stores the photo company-filed and deliberately
unattached. So a photo forwarded together with load text is processed in a
separate pipeline, seconds apart, with no shared context — the two can
never be linked. That is structural, not a model mistake.

### Fix requirements (burst linking — owner's rule)

Owner's rule, standing from 2026-11-09: **things forwarded together are one
package.** Implement it:

7. Extend burst collection to media: when a photo/document arrives while a
   burst is open for the chat (or within the burst quiet window after one),
   hold its filing decision until the burst flushes, then work the bundle
   as ONE turn. Albums already group by media_group_id; a forwarded photo
   + forwarded text in the same burst is the same idea.
8. When a bundle contains BOTH a trip assignment (parsed or model-extracted)
   AND a photo, the staged proposal is ONE batch: create the load AND
   attach the photo's document to that load, presented together for the
   owner's single yes. Identifiers read from the photo (trailer #, pickup
   #, seal #) are part of the same proposal: a trailer number that matches
   a trailer on file (or the trip's trailer) is proposed as that link too.
9. A photo that arrives ALONE keeps today's behavior (stored unfiled,
   purpose ask). This change is only about items that arrive together.

## Root cause 3 — no reference resolution: Abel guesses records (P0)

When the owner says "this load 1874", "the load I just sent", or names a
detail of a load, the model currently resolves it by browsing `list_loads`
and guessing — and guessed the completed Savannah load over the trip the
owner had created minutes earlier. `attach_document` takes a raw
`related_entity_id` from the model; its `summarize` even shows the owner
raw UUIDs. There is no code that maps the owner's words to a record.

### Fix requirements (resolution + thread memory)

10. **Deterministic reference resolution in code, before the model
    proposes.** Scan the owner's message for: a trip number ("1874",
    "trip 1874"), a broker reference, a trailer/truck number, a pickup #.
    Resolve each against the database (loads by trip_number /
    broker_reference, trailers/trucks by unit number, documents by
    extracted identifiers). Inject the resolved records into the turn
    context as fact ("Trip 1874 = load <id>, Panama City → Seminole,
    created today from his forward"). If a named trip number resolves to
    nothing, Abel says so — he never substitutes a different load.
11. **Current-subject pointer per chat.** The load/trip most recently
    created, staged, or discussed in this conversation is stored (the
    thread-capture store is the natural home) and used to resolve "this
    load", "that trip", "attach it to it" in follow-up messages. A
    completed load from days ago must never outrank the load from this
    conversation.
12. **One ask, one batch.** A request to attach a photo must stage only the
    attach proposals for it. Unrelated proposals (the "clear the pay
    override" item bundled into the attach answer) must not ride along.
13. **Proposal summaries name records in words, always** — trip number +
    lane + dates for a load, unit number for a truck/trailer, file name
    for a document. Raw UUIDs in an owner-facing summary are a defect
    (attach_document's `summarize` does this today; fix it or make the
    verified summary the one displayed).
14. **No raw tool errors to the owner.** A wrong-id tool call (the
    vehicle-defect error he was shown) must be retried from a real list
    read or turned into a plain "I couldn't find that one" — never the
    tool's error text.

## Make him smarter over time (owner's standing ask)

15. Every corrected real-world message becomes a permanent regression
    fixture. The Trip 1874 message (full text in the test spec below) is
    fixture #1. When the owner corrects a parse in chat, the correction
    path (fix 16) is what feeds this: corrected records are how the system
    learns the carrier's real formats. Do not build a separate "ML" pile;
    the learning loop is: real formats → fixtures → parser/prompt updates,
    plus the existing memory/thread stores for reference resolution.

## The correction path + repairing the live record

16. **Stops on an existing load are currently unfixable by Abel:**
    `load_stops` is written only inside create_load's afterCreate, and
    `update_load` strips `stops`. Add a tool (e.g. `set_load_stops` /
    extend update_load) that replaces a load's stops in one proposal, with
    the same propose→yes discipline and a summary that lists every stop in
    words. Without this, no wrong trip can ever be repaired in chat.
17. **Repair Trip 1874's record** as the acceptance run of fix 16 (staged
    for the owner's yes like everything else): load `50dde25b-…` becomes
    origin Panama City, FL → destination Seminole, OK; delivery_date
    2026-11-12; stops = (1) PICKUP Kontoor Panama City, 1 Seaport Drive,
    Panama City, FL 32401, 11/10/2026 08:00–16:00 America/Chicago;
    (2) DELIVERY Kontoor Seminole, 1400 Wrangler Boulevard West, Seminole,
    OK 74868, 11/12/2026 12:00 America/Chicago; (3) LOT TO Kontoor Panama
    City, 1 Seaport Drive, Panama City, FL 32401, 11/16/2026 12:00
    America/Chicago. The trailer photo (telegram-photo-20261109105023.jpg
    and its resent copy …105247.jpg — dedupe to one document if both are
    stored) attaches to this load, and trailer H11887 is linked as the
    trip's trailer if a trailer record matches (proposed, not assumed).
    Do NOT touch the record until the fix build is merged and the owner
    says yes to the staged correction.

## Regression tests (required, not optional)

- `parseDispatchTrip` on the verbatim Trip 1874 text returns **3 stops**:
  pickup Panama City 11/10 (window start AND end), delivery Seminole
  11/12, lot-to Panama City 11/16; no stop's fields contain another stop's
  data. `tripToCreateLoadArgs` → destination "Seminole, OK",
  delivery_date "2026-11-12", stops length 3, miles figures as printed,
  and the review flags the total-vs-sum mismatch.
- A two-stop STOP-only message (existing Trip 1234 fixture) still parses
  exactly as before.
- A message with an unnumbered leg under a DIFFERENT header wording still
  yields all its stops (no overwrite) — the guard is structural, not a
  hard-coded "LOT TO" string.
- Cross-check test: a parse that drops a SHIPPER/CONSIGNEE block present in
  the source is rejected/flagged, never staged as high-confidence.
- Burst test: photo + forwarded trip text in one burst produce ONE staged
  batch containing create_load and the document attach for that load.
- Resolution test: with two loads on file (one completed days ago, one
  created this conversation with trip_number 1874), the message "attach it
  to load 1874" resolves to the 1874 load; "attach it to this load" right
  after creating 1874 resolves to the same load.

## Boundaries (unchanged, do not widen)

- Propose→yes stays absolute: nothing in this brief records, attaches, or
  corrects anything without the owner's yes. No auto-send, no new
  authority. No commands — intent from conversation, as always.
- Build on a branch; merge to main is the owner's tap; deploy is a
  separate tap after merge. Gate: tsc + eslint + full vitest + next build,
  with the new tests above included and the counts reported honestly.
- Report back in the usual board format: what changed per fix number, the
  gate numbers, and anything you could not settle.
