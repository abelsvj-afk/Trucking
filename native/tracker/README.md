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
2. Open **Trucking OS Tracker**, paste both, tap **Start tracking**.
3. Allow location and notifications. **"While using the app" is enough** - the app does not declare the separate "all the time" permission; it keeps reporting with the app closed through a foreground service, and the "Trucking OS Tracker" notification that stays up while it reports is what keeps that service alive (Android requires it). If your phone offers "Allow all the time", choose it; do not swipe the notification away.
4. Phone settings → Apps → Trucking OS Tracker → Battery → **Unrestricted** (some makers kill background apps otherwise).

## Honest limits
- Built 2026-11-07 (debug APK, `assembleDebug` succeeded; manifest and bundled scripts inspected) but NOT run on a device by the builder. First real test: start tracking, lock the phone, drive; the Trucking OS Home map and the Telegram "Switched to Driving" notice are the proof.
- Battery use is real (a foreground location service). Stop tracking when you are off shift.
- If the server can't be reached, fixes wait in a queue (up to 500, 24 h) and are sent when signal returns.
- A revoked or wrong key stops tracking and says so.

## Dependencies (all MIT, maintained; vetted 2026-11-06)
`@capacitor/core|android|cli` 8.6.0, `@capacitor/preferences` 8.0.1, `@capacitor-community/background-geolocation` 1.3.1. `npm audit`: 0 vulnerabilities. Pinned, with a committed lockfile.
