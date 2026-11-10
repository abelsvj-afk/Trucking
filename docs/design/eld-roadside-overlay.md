# ELD-inspired features: roadside inspection mode + floating HOS overlay (owner spec 2026-11-09)

Owner source: `files/ELD-Inspired-Features-Spec-2026-11-09.md` in the trucking
goal (owner, 2026-11-09, after setting up the carrier ELD with Steven's
company). Two features, built together on one branch
(`feature/eld-roadside-overlay-2026-11-09`), branch-only: no merge, no
deploy, no live migration, no tracker release from this build.

## Honesty rule (governs every surface below)

While the owner drives leased on under the carrier's ELD (and keeps paper
logs), THAT system is the legal record. Everything in this build is a
**convenience copy / paper-log helper, never the certified ELD record**,
and every surface says so in plain words. The packet and the inspection
screen never expose pay/money data.

## Part A — Roadside / DOT inspection mode

### The packet (one source, every surface)

`src/lib/roadside-packet.ts` (pure) builds the inspection packet from the
ONE server-side HOS read (`loadHosWindow`, services/api/hos-window.ts) —
the same rows and cycle summary the Hours page, Abel and the HUD clocks
already state. No second HOS math anywhere in this feature.

Packet contents:
- Header: driver name, company name, the honest-framing line (convenience
  copy; the carrier ELD / paper log is the legal record), the period
  covered (today + the previous 7 days, America/New_York calendar days —
  the roadside look-back an officer asks for).
- The four current clocks (drive / 14-hour window / break / cycle) exactly
  as `computeHudClocks` states them, or "unavailable" — never fabricated.
- One block per day: each duty segment (status, start–end in Eastern time)
  and the day's driving / on-duty totals.

`src/services/roadside/packet-service.ts` assembles the live packet,
files it, and sends it:
- **Filed**: the packet text is uploaded to the documents bucket and a
  `documents` row (related entity `roadside_packet`) plus a
  `roadside_packets` row (migration 00086) record it. The roadside page
  itself is the preview / full-screen presentation until the documents
  build adds generic previews. (storeDocumentFile's allowlist is
  PDF/image only, so the packet service stores its own text file through
  the same bucket/table — noted here so the difference is deliberate,
  not drift.)
- **Emailed**: through the existing email machinery, extended as below.
- **Telegram**: `send_inspection_packet_to_me` sends the packet file to
  the owner's own Telegram chat (Bot API `sendDocument`, owner chat only,
  same config as the notifier) so he can show his screen.

### Standalone email sends (the one extension to the email machinery)

The existing machinery sends REPLIES: `email_drafts.email_message_id` is
NOT NULL and `sendApprovedDraft` derives the mailbox from the original
message. A roadside send is a NEW email to an officer. Migration 00086
therefore:
- drops NOT NULL on `email_drafts.email_message_id` and
  `email_sent.email_message_id` (the composite tenant FKs pass on NULL
  under MATCH SIMPLE, unchanged otherwise);
- adds `email_drafts.mailbox` (nullable, check in ('dispatch','owner')) —
  recorded explicitly on standalone drafts; reply drafts leave it NULL
  and keep deriving the mailbox from the original, exactly as today.

`sendApprovedDraft` keeps every guard (open draft, fingerprint = the
approved body hash, single plain address, send-enabled mailbox, atomic
claim, one connection-level retry, Sent-folder append, `email_sent`
record). For a standalone draft it additionally requires: the recorded
mailbox is `owner` (roadside sends go from owner@; dispatch@ stays
dormant under its existing env gate), and any attachment's text must
equal the approved draft body byte-for-byte — the officer receives
exactly the text the owner approved, as the body AND as the attached
packet file. `composeRaw`/`buildOutgoing` gain an optional attachments
parameter; reply sends pass none and are byte-identical to before.
The codebase guards the send path's narrowness with a test ("only the
send_email tool module imports the send service"); this build widens
that sanctioned list by exactly the two new owner-confirmed surfaces
(the roadside tools and the /roadside send route), recorded in the test
itself — no other module may import the send service.

### Surfaces

- **Web**: Home gains a prominent "Roadside inspection" button →
  `/roadside` (officer-facing: big type, clocks, the 8-day log, no app
  clutter, no money data, framing banner). A send form on the same page
  takes the officer's email; the page shows the packet and recipient
  before the Send button — that confirmation IS the approval, and
  `POST /api/v1/roadside/send` then builds, files and sends in one
  server call, returning the send result in plain words.
- **Abel (Telegram, the primary path)**: three tools, mirroring the
  proven email pattern —
  - `prepare_inspection_packet` (write, immediate when named): builds
    the packet for the officer email he gives, files it, saves the
    standalone draft, and shows him the recipient + packet + fingerprint.
  - `send_inspection_packet` (write, **always propose**): one
    confirmation — his YES sends via `sendApprovedDraft`. This is the
    streamlined roadside chain the spec demands: prepare → one yes → sent.
  - `send_inspection_packet_to_me` (write, always propose): sends the
    packet file into his Telegram chat to show on screen.
  `prepare_inspection_packet` is in the execute gate's named-action
  patterns like `draft_email_reply` (executes when his message names the
  inspection; a proposal when the model raises it unasked). Deliberately
  NOT built here: agent-turn code-staging of the packet send (the
  `stageEmailSendIfAsked` analogue) — that staging was a fix for a
  specific live email failure; the generic proposal flow carries the
  packet send, and staging joins it only if live use shows the same
  failure mode.

## Part B — Floating HOS overlay (Tracker Android app)

Platform truth (from the spec): a web app cannot overlay other apps; the
Tracker native app can, with the Android "draw over other apps"
permission. The overlay is therefore native Tracker code:

- **Data**: `POST /api/v1/position/clocks` — device-token authenticated
  exactly like the position feed (same token, same fail-closed 401, same
  rate limit discipline). The response is computed by `loadHosWindow` +
  `computeHudClocks` on the server: the four clocks (key, label,
  remaining ms, total ms, tone) + current duty status + compute time.
  The phone never computes HOS — it displays the server's clocks.
- **Tracker www** (`overlay.js` + pure `overlay-clocks.js`): a Settings
  toggle ("Floating HOS clocks"). While on and configured, it polls the
  clocks endpoint every 30 s (native HTTP, saved server + key only) and
  hands the values to the native plugin. Display refresh only — no HOS
  logic in JS beyond formatting what the server sent.
- **Native** (`HosOverlayPlugin` + `HosOverlayService`): a small
  always-on-top card (WindowManager, TYPE_APPLICATION_OVERLAY) showing
  DRIVE / WINDOW / BREAK / 70-HR in large numbers, updated from the
  plugin's values, ticking down by wall clock between server refreshes
  (display smoothing only — the next 30 s refresh re-anchors to the
  server's read). The service is independent of the WebView, so the card
  stays on screen after the app closes, until dismissed (the card's ✕,
  the Settings toggle, or stopping tracking). Clocks only: no duty
  controls, nothing that invites interaction while driving beyond the ✕.
  Permission: the plugin reports `Settings.canDrawOverlays` and opens
  the system grant screen when missing; without the grant the toggle
  explains itself and nothing is drawn.
- **Release**: this build does NOT cut a tracker release and never
  touches the release keystore. The overlay rides the next signed
  tracker release (which, per the keystore change, needs the owner's
  one uninstall/reinstall on his phone).

## Migration 00086

`supabase/migrations/00086_roadside_packets_and_standalone_email.sql` —
authored on this branch, **NOT applied** (the expense build's 00084/
00085 numbering was checked when this build started: main carries
through 00083, the research branch holds 00084, the expense branch 00085;
00086 is next and collides with neither). Contents: the two email
nullability changes + `email_drafts.mailbox`, and the `roadside_packets`
table (tenant-isolated RLS like the rest of the family). All new code
degrades honestly before 00086 lands (the roadside page still presents
the packet; filing/sending report that the database step is not in yet
instead of pretending).

## Verification state (honest)

- Web side: full gate (typecheck / lint / vitest / production build)
  with persisted logs — see the build report for counts.
- Android side: **no JDK or Android SDK exists on this VM**, so the
  Gradle build could not run here. The Java/XML/www code is verified by
  code-level checks only (structure, manifest, plugin registration,
  unit tests over the pure JS clock formatting). The first real compile
  is the next tracker release build on a machine with the SDK — stated
  plainly so nobody mistakes this for a device-proven build.
