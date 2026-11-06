# Tracking that keeps working with the app closed (design)

Source: the owner, 2026-11-06 — the automatic switch to Driving must work "because that's how they actually work in real life", and he remembers apps that "still ran in the background once I closed it". This is the honest map of what can and cannot do that, what is built, and the one decision needed.

## The hard fact
A web page (including an installed "add to home screen" web app) is suspended by the phone the moment it is closed, backgrounded or the screen locks. It cannot read GPS then — on iPhone or Android, regardless of how we write it. Real ELD apps run in the background because they are **native apps** with the phone's background-location permission. There is no web trick that changes this.

## Path 1 — built now: Telegram Live Location (no install)
Telegram's own app keeps streaming the phone's position to Abel with the screen off and our app closed (`edited_message.location` → `driver_positions`). The server now runs the **same automatic switch** on that stream:
- moving ≥ 5 mph (derived from consecutive fixes; jitter under ~16 m counts as zero) for 60 s, then a 30 s grace, while the log says anything but Driving → one Driving row is added, **stamped at the detection time** (movement start + 60 s), `source auto_motion`, with a Telegram notice "Switched to Driving at … — truck moving";
- same shared rules as the open-app path (`services/fleet/auto-motion.ts`): only ever INTO Driving, never edits earlier rows, a status he set by hand during the move wins, idempotent per detection, kill switch `auto_duty_switch` (default on);
- Driving + stopped 5 min → Abel asks (a proposal he approves; it never switches out of Driving by itself).
Limits: he has to START sharing in Telegram (a live location lasts at most 8 hours, so it is a daily start-of-shift tap); Telegram's update cadence is coarser than on-screen GPS; if Telegram is force-quit or location sharing stops, nothing is reported (the Home banner says when the app can't tell).

## Path 2 — the real answer: a thin native shell
A small native wrapper (Capacitor) that loads this same web app and adds one native capability: a **background geolocation service** that keeps posting fixes to the server while the phone is locked and our app is closed — exactly what ELD apps do. Designed shape:
- *Server (can be built before the shell):* `POST /api/v1/position/feed` accepting batches of fixes from a **device token** (a long-lived, revocable, scope-limited secret issued from Settings and stored hashed; the session cookie cannot be used from native background code). It feeds the SAME detection/auto-switch code as Telegram (`handleLiveLocation` is generalized to a source-agnostic ingest), writes `driver_positions` with `source 'device'` (a migration widens the check), and is rate-limited and validated like every external-facing entry point.
- *Shell:* Capacitor project (new top-level `native/`), the web app loaded from the deployed URL, `@capacitor-community/background-geolocation` (MIT, free) configured with a persistent foreground-service notification on Android ("Trucking OS is tracking your location") — the OS requires that notice and it is also what keeps the service alive.
- *Distribution:* **Android** — install a signed APK directly (no store, free) or Play internal testing. **iPhone** — needs an Apple Developer account ($99/yr) and TestFlight; iOS also limits background location more (the "Always" permission, a blue status-bar indicator) but works for this use.
- *Cost/free-first:* the plugin and Capacitor are free. The only paid item is Apple's $99/yr, and only if he is on iPhone; there is no free route to a background-capable iPhone app.
- *Honest limits:* battery use is real (a foreground service every few seconds); the shell must be rebuilt for OS updates; iOS review/signing is a recurring chore. This is paper-log-helper tracking, not a certified ELD.

## Decision needed (owner)
1. **Phone: iPhone or Android?** It decides the shell's cost and distribution.
2. Go ahead with Path 2 after that (server feed first, then the shell project), keeping Path 1 as the no-install fallback.

## What this does NOT change
Locked forms while moving stay locked, the status switcher stays exempt, a manual choice always beats the automatic one, and nothing automatic ever switches out of Driving.
