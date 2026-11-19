# Location voice notes (2026-11-19)

**Owner idea (2026-11-18):**
- Tap the mic and leave a voice note tied to a spot on the map.
- Coworkers coming up on it see a bubble on the map and in the left-hand list, with the distance ticking down, and can tap to listen from far ahead.
- The icon shakes and pulses until that driver has listened AND passed it. Then it disappears for him only, and stays for the next driver.
- Purpose: warnings and tips coworkers leave each other in real time.

Branch `fix/map-finish-2026-11-19`; migration `00101_voice_notes.sql`.

## Owner decisions (2026-11-19)

**Passed:** he went past the spot, going the same way (headings within 60°, at least 0.1 mi beyond it after being within 0.15 mi). If a pass is never detected (GPS gap, detour), the note clears for him **30 minutes after he listened**.

**Lifetime by type:**

| Type | Lives for |
|---|---|
| Traffic / wreck | 2 hours |
| Road work | 7 days |
| Low bridge | until cleared |
| Hazard | until cleared |
| Tip | 30 days |

**Clearing for everyone:** a coworker who finds the hazard gone taps **It's gone**, and that clears it for every driver. The number of reports needed grows with the fleet ("gated to more than one driver once more and more users use my app"):

| Company size | Reports needed |
|---|---|
| 1–3 | 1 |
| 4–20 | 2 |
| 21+ | 3 |

**Wrong note** uses the same gate. The author's own report never counts toward clearing his note; he removes it instead.

## Rules (in `src/lib/voice-notes.ts`, pure, unit-tested)

**Never pesters its author:**
- his own notes are not shown to him as alerts;
- he can remove them (`DELETE /api/v1/voice-notes/:id`, author-only by row-level security).

**Duplicates stack:** the same type, going the same way, within 0.2 mi, shows as one bubble ("· 2 drivers"); the newest plays first.

**Freshness** shows on every chip: "12 min ago", "3 h ago".

**A note he has reported** is done for him at once.

**Shown when:**
- it is within 0.25 mi of his route line;
- it was left going his way (compared with the road's own direction at that point);
- it is up to 30 mi ahead.

Distances use the same road-miles measurement as everything else on the map (route-measure.ts).

**Spoken once**, about 1 mi out: "Voice note from a driver ahead: low bridge, in 0.9 miles. Tap it to listen."

## Recording (cab-safe)

- One tap starts recording, one tap stops; it also stops itself at **30 s**.
- Then he picks one of five big type buttons, or Discard.
- The note is pinned where the truck was when recording **started**, with his direction of travel and the road number from the where-am-I lookup.
- A blocked microphone or an unsupported browser says so plainly.

## Animation (cheap on a phone)

- A pulse ring on `::after` and a shake on an inner span, using CSS `transform` and `opacity` only. The marker element's own transform belongs to MapLibre.
- Turned off for `prefers-reduced-motion`.

## Storage and privacy

- Audio goes in the existing private `documents` bucket under `<company_id>/voice-notes/`, so 00007's company-isolation storage policies apply.
- Allowed types: webm/ogg/mp4/mpeg/aac, at most 1.5 MB.
- Played through 5-minute signed links.
- If the row fails, the uploaded file is removed (no orphans).
- RLS for the three tables:
  - `voice_notes`: everyone in the company reads; a driver inserts only as himself; only the author updates.
  - `voice_note_views`: a driver reads and writes only his own rows.
  - `voice_note_reports`: everyone in the company reads; a driver files only his own.
- `company_member_count()` (security definer) returns only a count, so `user_profiles` stays readable row-by-row only.

## Not in this version

- No transcript or speech-to-text: drivers listen to the note.
- No push notification to drivers who don't have the app open.
