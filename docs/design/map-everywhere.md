# The map for real while driving (2026-11-19)

**What the owner reported (2026-11-19):**
- The map must go small and float around the phone.
- The Tracker's floating hours clock is stuck in a corner and can't be dragged.
- The map must keep the screen awake; if a web page can't, the Tracker must.
- The map must be in the Tracker app as well as in the browser.
- His ElevenLabs voice should speak, with each clip made once and reused.

## Why the hours clock wouldn't move

The drag code (`HosOverlayDrag` + the touch handler, commit `c875439`) was written on 2026-11-17, about two hours **after** the Tracker 1.1.2 APK was built. The phone never had it. Tracker **1.2.0** ships it.

## Keeping the screen awake — two layers

1. **Browser.** The drive page holds a Screen Wake Lock (`use-screen-wake-lock.ts`) while it is open.
   - The browser drops the lock whenever the page is hidden, so the page asks again each time it comes back.
   - When the browser can't hold the lock, the page says so and points to the Tracker's map.
2. **Tracker.** The map screen (`MapActivity`) sets `FLAG_KEEP_SCREEN_ON`. This is native, so it doesn't depend on the browser.

## The map inside the Tracker, floating

**One map.** `MapActivity` shows the app's own live drive map (`<saved server>/smart-path/drive`) in a WebView. It is the same code as in the browser, not a second map. He logs in there once; the login is remembered.

**Floating.** Pressing Home (or switching apps) puts the map into Android **picture-in-picture**:
- a small floating window that the system lets him drag anywhere and pinch to resize;
- tap it to bring the full map back;
- the system owns the window, so it cannot get stuck the way a hand-made overlay can.

If picture-in-picture is switched off for the app in the phone's settings, the map closes instead. The More → Tracker app page says how to allow it.

**Locked down:**
- only the saved server's own host loads inside it; every other link is refused;
- location and microphone are granted only to those pages — the microphone for voice notes, asked only when he taps the mic.

**Install:** version 1.2.0 (versionCode 9) uses the same signing key as 1.1.2, so it installs over it without an uninstall. It is served from More → Tracker app (`public/downloads/trucking-os-tracker-1.2.0.apk`).

## His ElevenLabs voice — each line made once (`services/voice/spoken-clips.ts`)

**Request:** `POST /api/v1/voice/speak { text }` returns a playable link.

**Caching:**
- Each line is saved at `<company>/tts/<sha256(voice|model|exact text)>.mp3` in the private `documents` bucket.
- If the clip is already saved, it is served from storage with **no ElevenLabs call**.
- A new line is generated once, saved, then played.
- The phone also remembers links, so it asks for a line once per hour at most.

**Voice:** the ElevenLabs voice he chose for calls (`companies.call_voice_id`, "elevenlabs.<model>.<VoiceId>"), else `ELEVENLABS_VOICE_ID`.

**Cost:**
- Characters come from his ElevenLabs plan.
- `ELEVENLABS_MONTHLY_CHAR_BUDGET` (default 8,000) stops NEW clips for the month; saved clips keep playing.
- The budget month runs on his calendar (Eastern), not UTC.
- Lines that carry live decimals ("In 4.4 miles…") are mostly unique, so most new lines cost characters. The budget is what keeps this inside his plan.

**Fallback:** with no key, the budget reached, or the provider down, the phone's own voice says the line. Speech never goes silent.

**Key:** `ELEVENLABS_API_KEY`, a Fly secret only — never in git, a log, a response, or chat.
