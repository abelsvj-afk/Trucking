# ELD Compliance Roadmap — Road to Legacy, Trucking Business OS

Owner's vision, in his words: when the company is his, this app is the main thing the
business runs on — not a commercial ELD. Every driver gets the app, the server link,
and their own individual key/login. Tracking, logs, and records all live in one
system, integrated with AI (Abel), funded properly when the business can carry it.

This note is the standing checklist of everything required to take the app from
"GPS tracker" to a lawful Electronic Logging Device (ELD) under US federal rules.
It is a planning document, not legal advice. The governing law is 49 CFR Part 395,
Subpart B (§§ 395.20–395.38) and the technical specifications in Appendix A to
Part 395.

Created 2026-11-07 at the owner's request.

---

## The one hard truth

An app by itself can never be an ELD. Federal rules require the device to be
**integrally synchronized with the truck's engine** so driving time, miles, and
engine hours are captured automatically from the ECM — GPS alone does not count.
The compliant product is therefore: **engine-connected hardware + this app + the
server**, self-certified and registered as one system. Everything below hangs off
that fact.

Also know: FMCSA does **not** approve or certify ELDs. The manufacturer tests
against the spec, **self-certifies**, and registers the device on the FMCSA
Registered ELDs list (eld.fmcsa.dot.gov). If a registered device is later found
non-compliant, FMCSA can revoke the listing — and every log it produced becomes a
problem for the carrier. Self-certification is a legal claim, not a formality.

---

## Where we stand today (honest status, 2026-11-07)

Already true of the current system:

- [x] Phone-based tracker app (Android) reporting GPS positions to our own server
- [x] Per-device keys — each install authenticates with its own device key
- [x] Server address + key saved on-device; main screen shows saved values
- [x] Server-side record of positions with timestamps (proof-of-miles trail)
- [x] Multi-driver shape is possible: one key per driver, records tagged per key

Not yet true (this is the gap this roadmap closes):

- [ ] No connection to the truck's engine (no ECM data at all)
- [ ] No duty-status logbook (no RODS — records of duty status)
- [ ] No hours-of-service rules engine or violation warnings
- [ ] No roadside data-transfer output in the FMCSA standard format
- [ ] No malfunction/diagnostic system
- [ ] No self-certification or FMCSA registration
- [ ] iOS version of the tracker does not exist yet

Until every section below is checked, the app is a **fleet tracker and
accountability tool — not an ELD** — and any driver required to keep logs must
use a registered ELD or lawful paper logs alongside it.

---

## Part A — Legal frame: who must use an ELD, and when we would qualify

- [ ] Confirm which operations trigger the ELD mandate (drivers required to keep
      records of duty status under §395.8, interstate commerce, CMVs as defined
      in §390.5)
- [ ] Map the exemptions and whether any of our work fits them:
  - [ ] Short-haul exception (§395.1(e)) — within 150 air-mile radius, return to
        work-reporting location, duty limits met → time records instead of logs
  - [ ] Drivers who keep RODS on no more than 8 days in any 30-day period
        (paper logs allowed for those days)
  - [ ] Vehicles with engines manufactured before model year 2000
  - [ ] Driveaway-towaway operations (the vehicle is the cargo)
- [ ] Decide the trigger point for this project (expected: when the owner runs
      under his own authority and puts on the first hired driver)
- [ ] Confirm state intrastate rules for any Florida-only work (states adopt
      their own HOS/ELD equivalents for intrastate carriers)

## Part B — Engine connection (the hardware gate)

- [ ] Choose the engine interface hardware:
  - [ ] J1939 (9-pin / 6-pin CAN) for heavy-duty trucks (post-~2001 engines)
  - [ ] J1708/J1587 fallback for older heavy-duty trucks
  - [ ] OBD-II only if lighter vehicles ever join the fleet
  - [ ] Decide: buy a proven Bluetooth/CAN dongle from a hardware vendor vs.
        build our own (buying is the realistic path; the spec burden is the same)
- [ ] Hardware must capture, automatically, from the ECM:
  - [ ] Engine power status (on/off)
  - [ ] Vehicle motion status (moving = speed at/above 5 mph threshold logic)
  - [ ] Vehicle miles (ECM odometer)
  - [ ] Engine hours (cumulative)
- [ ] Synchronization achieved within one minute of engine power-on
- [ ] Connection survives vibration, power cycles, and phone disconnects
      (buffering in hardware or app when the link drops)
- [ ] One hardware unit assigned per power unit; pairing workflow documented
      (driver selects/confirms the truck, app records the power unit number)

## Part C — Automatic recording (what the ELD must capture, §395.26 + Appendix A)

For every record, the system must capture: date, time, location, engine hours,
vehicle miles, driver/user identification, vehicle (power unit) identification,
and motor carrier identification.

Automatic events to implement:

- [ ] Engine power up and power down
- [ ] Vehicle motion start (auto-switch to Driving at 5 mph sustained) and stop
- [ ] Every change of duty status
- [ ] Intermediate location record at least once every 60 minutes while driving
- [ ] Login / logout events (authenticated user identity)
- [ ] Malfunction and diagnostic events (Part H)
- [ ] Location precision: within a 1-mile radius normally; reduced precision
      (10-mile radius) while the driver is in personal use (off-duty driving)

Duty-status handling:

- [ ] Four statuses supported: Off Duty, Sleeper Berth, Driving,
      On Duty (Not Driving)
- [ ] Driving is set automatically from vehicle motion — the driver cannot
      choose it manually and cannot shorten recorded driving time
- [ ] When the truck stops, prompt the driver; if no response within the
      allowed window, default per spec (On Duty Not Driving after the vehicle
      has been stationary per the Appendix A timing rules)
- [ ] Special driving categories, enabled by the carrier and selected by the
      driver with a required annotation:
  - [ ] Personal conveyance (personal use)
  - [ ] Yard moves
- [ ] Co-driver support: team drivers each logged in, statuses tracked
      separately, driver-switch workflow without stopping the truck's records

## Part D — The driver logbook experience

- [ ] Driver can view the current day and the previous 7 days at all times
      (records retained on the device for today + 7 days minimum)
- [ ] Graph-grid display of the 24-hour period, in the standardized format an
      officer expects at roadside
- [ ] Header data on display/printout: driver name, co-driver, carrier,
      truck/tractor and trailer numbers, shipping document numbers, total
      miles today, 24-hour starting time
- [ ] Driver edits allowed for non-driving records, but:
  - [ ] Original records are never altered or deleted — edits layer on top
  - [ ] Every edit requires an annotation (reason, at least 4 characters)
  - [ ] Full edit audit trail kept (who, when, what changed)
  - [ ] Carrier-proposed edits must be presented to the driver, who may accept
        or reject them; nothing changes silently
- [ ] Driver certification: driver certifies each 24-hour period's records;
      prompted at login if prior records are uncertified
- [ ] Unidentified driving: driving recorded with no driver logged in is held
      as unidentified-driver events for the carrier to assign or annotate
      (Part F)
- [ ] The driver can produce records on demand at roadside (Part G)
- [ ] Plain-language clock explainers in-app (what each clock means, what
      happens at zero, what resets it) — owner requirement: the app teaches,
      not just displays

## Part E — Hours-of-service rules engine

(The ELD records time; the rules engine is what keeps drivers legal. Not
strictly required for registration, but commercially and practically essential.)

- [ ] Property-carrying driver limits (the rules our operation runs under):
  - [ ] 11-hour driving limit after 10 consecutive hours off
  - [ ] 14-hour driving window
  - [ ] 30-minute break required after 8 cumulative hours of driving time
  - [ ] 60/70-hour limit in 7/8 days
  - [ ] 34-hour restart provision
  - [ ] Sleeper-berth split provisions (7/3 and 8/2 splits, pair rules)
  - [ ] Adverse driving conditions extension (up to 2 hours, correctly gated)
  - [ ] Short-haul exception logic for qualifying days
- [ ] Warnings before a violation, not after (configurable lead times)
- [ ] Recap views: hours gained back at midnight, cycle totals
- [ ] All computations in the driver's local time context for display
      (home-terminal time zone for the official record, per §395 rules)

## Part F — Back office (carrier side, on the server)

- [ ] Unique driver accounts: no shared logins; authenticated user IDs
- [ ] Carrier account can review every driver's records, propose edits
      (driver accepts/rejects — Part D), and manage annotations
- [ ] Unidentified driving events workflow: review, assign to the right driver
      with annotation, or retain as unidentified with explanation
- [ ] Retention: ELD records and supporting documents kept at least
      **6 months**, retrievable, with a backup copy kept separately
      (independent backup location, per §395.22 retention/backup expectations)
- [ ] Supporting documents linkage (§395.11): bills of lading, dispatch
      records, fuel receipts, etc., tied to the driver's day
- [ ] Reports: per-driver logs exportable in the standard format; inspection
      history; violation reports for safety management
- [ ] Harassment/coercion safeguards: the system must not let the carrier
      pressure edits that falsify records (§390.13 / §395.22 protections);
      driver rejection of edits is final in the record
- [ ] Road to Legacy layer: per-driver keys/logins already planned — the ELD
      identity system grows out of the device-key system the tracker uses now

## Part G — Roadside: data transfer and display

An ELD must offer **both** transfer families, and the driver picks at roadside:

- [ ] Telematics: wireless web service transfer to FMCSA systems
- [ ] Telematics: email transfer
- [ ] Local: USB 2.0 transfer
- [ ] Local: Bluetooth transfer
- [ ] Standardized output file generated exactly to the Appendix A file spec
      (data elements, ordering, and data-check values — a malformed file is a
      failed inspection)
- [ ] On-screen display option for an officer who will not take a transfer
      (graph grid + event list, current day + previous 7 days)
- [ ] In-cab printed/paper instruction materials the driver must carry:
  - [ ] ELD user's manual (can be electronic per current guidance, but kept
        available)
  - [ ] Instruction sheet: how to transfer data to an officer
  - [ ] Instruction sheet: malfunction procedures (Part H)
  - [ ] Supply of blank paper log sheets sufficient for 8 days
- [ ] Roadside rehearsal: test the full transfer with a phone + laptop before
      any driver depends on it

## Part H — Malfunctions and diagnostics

- [ ] Built-in diagnostic monitoring for at least:
  - [ ] Power compliance malfunction
  - [ ] Engine synchronization compliance malfunction
  - [ ] Timing compliance malfunction
  - [ ] Positioning compliance malfunction
  - [ ] Data recording compliance malfunction
  - [ ] Data transfer compliance malfunction
  - [ ] Missing data / data element diagnostics
- [ ] Malfunction indicator visible to the driver (in-app indicator; hardware
      lamp if the hardware provides one)
- [ ] Driver workflow: on malfunction, switch to paper logs immediately;
      records reconstructed for the current day and previous 7 days as needed
- [ ] Driver must notify the carrier in writing within 24 hours of a
      malfunction — in-app notification flow that timestamps it
- [ ] Carrier must repair or replace the device within 8 days; extension only
      via FMCSA notification if more time is genuinely needed
- [ ] Every malfunction/diagnostic event itself recorded with the required
      event codes and kept with the driver's records

## Part I — Integrity, security, and privacy

- [ ] Tamper resistance: original driving records cannot be shortened,
      reclassified, or deleted by driver, carrier, or admin
- [ ] Every record carries data-integrity check values per the Appendix A spec
- [ ] Authenticated access only — driver, co-driver, and carrier roles with
      separate permissions
- [ ] Clock integrity: device time synchronized against a reliable source;
      timing drift detected and logged (records internally consistent to the
      spec's time standard)
- [ ] Location recorded only at the events the spec requires, at spec
      precision (no extra-precision tracking inside official records;
      personal-use precision reduction enforced automatically)
- [ ] Encrypted transport between app, hardware, and server; keys per driver
      (extends the tracker's device-key model)
- [ ] Server access controls: the owner is the only admin; driver data is not
      visible to other drivers

## Part J — Self-certification and FMCSA registration

- [ ] Build and test against FMCSA's published ELD test procedures
      (the agency's test plan covers vehicle interface, data processing,
      monitoring, recording, and transfer)
- [ ] Fix every spec deviation found in testing **before** registering —
      registering a non-compliant device invites revocation
- [ ] Prepare the registration package: manufacturer/carrier identity, device
      name and model, software version, device identifier, and the
      self-certification statement that the device meets Part 395 Subpart B
- [ ] Register the device on the FMCSA ELD registration site; confirm the
      listing appears on the public Registered ELDs list
- [ ] Version discipline: software updates tracked; know when an update needs
      the registration details updated (model/version changes)
- [ ] Write the user manual and both instruction sheets (Part G) — these are
      part of the product, not an afterthought
- [ ] Keep test evidence and design documents archived (if FMCSA ever asks how
      we verified compliance, the answer must exist on paper)
- [ ] Ongoing watch: FMCSA revokes listings regularly; monitor the rule for
      amendments (e.g., pending ELD rule revisions) and re-verify the device
      against any spec change

## Part K — Running it as a carrier (operations around the device)

- [ ] Driver training: every driver trained on login, status changes, edits,
      certification, transfer, and malfunction procedures before driving
- [ ] Policy page in the driver handbook: falsification is a firing offense;
      edit-annotation rules; personal conveyance rules for the company
- [ ] Dispatch discipline: dispatchers see hours before assigning loads
      (the app's pay/load reasoning already respects HOS — extend it to the
      official record once the ELD exists)
- [ ] Audit rhythm: weekly unidentified-driving cleanup, monthly log audits,
      violation coaching records
- [ ] Roadside kit in every truck: instruction sheets + blank logs (Part G)
- [ ] If a driver is ever placed out of service over logs, the post-incident
      review feeds back into training

---

## Phased build plan for Road to Legacy

- **Phase 0 — Tracker (now).** GPS reporting per device key to our server.
  Accountability and proof-of-miles. **Not an ELD.** DONE in first form;
  hardening continues (real-device testing, exact-error display, iOS later).
- **Phase 1 — Logbook.** Driver duty-status logbook in the app (manual +
  GPS-assisted), graph grid, edits with annotations, certification,
  6-month server retention, HOS rules engine with warnings. Lawful only as a
  supplement or for exempt/paper-log operations — still **not an ELD** without
  engine sync. This is the biggest single build.
- **Phase 2 — Engine sync.** Choose and integrate the ECM hardware (J1939
  first). Automatic driving, miles, and engine hours from the truck. Buffering
  and diagnostics. This is the phase that makes ELD possible at all.
- **Phase 3 — Compliance plumbing.** Standard output file, all four transfer
  methods, malfunction system, unidentified-driving workflow, edit audit
  trail, backup retention.
- **Phase 4 — Certification.** Test against FMCSA procedures, fix deviations,
  write the manual and instruction sheets, self-certify, register, verify the
  public listing.
- **Phase 5 — Fleet rollout + AI layer.** Per-driver rollout under the owner's
  authority; Abel/AI features on top of the compliant core (load and pay
  reasoning that already respects the clocks, coaching, audit digests) —
  funded by the business, including the API budget for driver-facing AI.

Trigger to move past Phase 1: the owner operating under his own authority with
the first truck and first driver. Until then, Phases 0–1 still pay for
themselves as tracking and logbook tooling for his own driving.

## Open decisions for the owner

- [ ] Hardware path: buy commercial Bluetooth ECM dongles vs. long-term own
      hardware (recommendation on file: buy proven dongles first)
- [ ] Whether Phase 1 logbook ships for his own use while still driving for
      another carrier (policy check: the employing carrier's own ELD rules
      govern his official logs there)
- [ ] iOS tracker/ELD timeline (drivers will arrive with both phone types)
- [ ] Budget line for certification phase (testing time is the real cost —
      registration itself is a filing, not a purchase)

## Sources

- 49 CFR Part 395, Subpart B (§§ 395.20–395.38) and Appendix A to Part 395 —
  the ELD rule and technical specifications (ecfr.gov)
- FMCSA ELD website and Registered ELDs list — eld.fmcsa.dot.gov
- FMCSA ELD technical test procedures (published by the agency for
  manufacturer self-testing)
