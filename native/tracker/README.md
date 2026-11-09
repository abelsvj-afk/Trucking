# Trucking OS Tracker (Android)

A thin native shell whose only job is to keep reporting the truck's position **with the app closed and the screen off**, so Trucking OS can switch your log to Driving on its own (docs/design/background-tracking.md, Path 2). It posts to `POST /api/v1/position/feed` with a per-phone **device key** made in Trucking OS → Settings → Background tracking. A key can only send position. Paper-log helper, not an ELD.

## Build (needs a machine with the Android SDK; Maven Central may answer 429 through a shared proxy - re-run `gradle assembleDebug --max-workers=1`, downloads are cached - Android Studio, or the command-line tools + JDK 17+)
```
cd native/tracker
npm ci
npx cap sync android
cd android && ./gradlew assembleDebug      # APK: android/app/build/outputs/apk/debug/app-debug.apk
```
Install the APK on the phone (USB `adb install -r app-debug.apk`, or send the file to the phone and open it; allow "install unknown apps" for that source once). No store, no fee.

## First run on the phone
1. Trucking OS → Settings → Background tracking → name the phone → **Make a key**. Copy the key (shown once) and note the server address.
2. Open **Trucking OS Tracker** → **Settings**, paste the server URL and the key, tap **Save**. They are saved on the phone only; the main screen then shows the saved address (and only the key's last 4 characters). Tap **Start tracking**.
3. Allow location and notifications. **"While using the app" is enough** - the app does not declare the separate "all the time" permission; it keeps reporting with the app closed through a foreground service, and the "Trucking OS Tracker" notification that stays up while it reports is what keeps that service alive (Android requires it). If your phone offers "Allow all the time", choose it; do not swipe the notification away.
4. Phone settings → Apps → Trucking OS Tracker → Battery → **Unrestricted** (some makers kill background apps otherwise).

## Floating HOS clocks (added 2026-11-09, unreleased - rides the next release)
Settings → **Floating HOS clocks** turns on a small always-on-top card with the four HOS clocks (DRIVE / WINDOW / BREAK / 70-HR). How it works: the page polls `POST /api/v1/position/clocks` every 30 s with the saved server + device key; the server computes the clocks with the one HOS read (the phone never computes HOS); the native `HosOverlay` plugin hands the values to `HosOverlayService`, which draws the card (WindowManager overlay) and counts it down between polls, re-anchoring on every poll. The service is independent of the app screen, so the card stays up after the app closes, until the card's ✕, the Settings switch, or the process dying. It needs Android's "display over other apps" permission - the switch walks the driver to the system grant screen when it is missing. Clocks only: no duty controls on the card.
Honest build state: written 2026-11-09 on a machine with **no JDK/Android SDK**, so this code has NOT been compiled or run on a device by the builder - the pure JS half is unit-tested (`tests/unit/native/overlay.test.ts` in the main repo); the Java/XML half is verified by reading only. First real build should compile it with `npm run sync && cd android && ./gradlew assembleDebug` and check the card on a phone before any release.

## Honest limits
- Built 2026-11-07 (debug APK). v1.0.0 and v1.0.1 had a dead Start button: the page called `Capacitor.registerPlugin`, which only Capacitor's JS core provides, and never loaded the core. v1.0.2 loads `www/capacitor-core.js` (copied from `@capacitor/core` by `npm run sync`) and was checked in Chromium against a native-bridge stand-in: Start reaches the location plugin. Still NOT run on a real device by the builder.
- Always build with `npm run sync` (not a bare `npx cap sync`), so the core file is refreshed. First real test: start tracking, lock the phone, drive; the Trucking OS Home map and the Telegram "Switched to Driving" notice are the proof.
- Battery use is real (a foreground location service). Stop tracking when you are off shift.
- If the server can't be reached, fixes wait in a queue (up to 500, 24 h) and are sent when signal returns.
- A revoked or wrong key stops tracking and says so.

## Dependencies (all MIT, maintained; vetted 2026-11-06)
`@capacitor/core|android|cli` 8.6.0, `@capacitor/preferences` 8.0.1, `@capacitor-community/background-geolocation` 1.3.1. `npm audit`: 0 vulnerabilities. Pinned, with a committed lockfile.

## Connection errors and the log (v1.0.4)
- **Why "can't reach the server" used to appear no matter what was saved:** the app's page runs at `https://localhost` inside Android's WebView, and a browser-style `fetch` with an Authorization header to your server needs a CORS permission check (OPTIONS) that `/api/v1/position/feed` does not answer - so the WebView blocked the request before it left the phone. v1.0.4 turns on Capacitor's native HTTP (`plugins.CapacitorHttp.enabled` in `capacitor.config.json`), which sends requests through Android itself, with no CORS check. Not verified on a real device by the builder.
- Every request uses the SAVED server URL and key (Settings), never half-typed fields. A change saved while tracking applies to the next send.
- The status line shows the EXACT reason: the server's own HTTP status plus its error code/message (for example `Server answered HTTP 401 - UNAUTHORIZED: Unauthorized.`), or the network error (`No answer from <host> - TypeError: Failed to fetch ...`). A 200 that is a web page (login redirect, wrong address) is reported as such, not as success.
- **Connection log** (main screen): the last 60 events, kept across restarts, also written to the phone's console (`adb logcat | grep tracker`). The device key is never in it.
