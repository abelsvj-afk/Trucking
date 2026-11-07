# Agent Dispatch Build Plan — Road to Legacy, Trucking Business OS

**Status: PLAN ONLY — nothing in this document is built, merged, or deployed by
this document itself.** Each phase below still needs the owner's tap to build,
a separate tap to merge, and a separate tap to deploy, exactly like every
other change in this repo.

**Owner's north star (2026-11-07 voice call, recorded in the goal file):**
agents do every job that can be automated. The agent runs on its own cloud
computer, logs into the load boards itself, reads what's posted, and
dispatches him and his future drivers according to each person's lifestyle
and the money they're trying to make. Pay is per mile driven no matter what —
evolving to a percentage of the load — plus bonuses. The economics are
employees-first on purpose: cut cost anywhere it can be cut in
infrastructure, and put the money into the trucks and into the employees'
pockets and lives instead. The agent back office handles dispatch planning,
contacting brokers by email and responding to broker emails, and keeping
everybody up to date.

**Baseline this plan was written against (verified, not assumed):**
`main` at `306e58ebf3db3c65e81df07b46b5d9c3bbc37106` on 2026-11-07
("Abel: stickers, reactions and emoji personality; temporal reasoning,"
Claude, 2026-11-07 ~10:25 AM Eastern). `PROJECT_STATE.md` in the repo was
last reconciled 2026-11-05 against `3144aa7`; where it and newer commits
disagree, the commits win. Production is Fly (trucking.fly.dev); the exact
deployed release does not equal current `main` — several gated units
(Abel audit fixes, pay-by-percent surfaces, webhook repair) are built and
on `main` but not yet proven live. This plan treats "built," "merged,"
"applied," "deployed," and "verified live" as five different states,
because they are.

**Governing documents this plan must stay consistent with — it does not
replace any of them:**

- `docs/governance.md` — authority levels 1–6, graduated autonomy,
  escalation, two-tier revocation (global kill switch + per-capability
  switches). No capability in this plan ships without its own switch.
- `docs/ai-authority-matrix.md` — the per-capability levels as they exist
  today. This plan classifies *future* behavior; it grants nothing.
- The owner's 2026-10-31 autonomy ladder, extended (not replaced) by the
  2026-11-07 north star — see §0.2, the hard limits.
- `docs/eld-compliance-roadmap.md` — the compliance path. Nothing in this
  plan calls the app an ELD, and no dispatch feature may depend on the app
  being one. See §5.
- `docs/design/employer-pay-profile.md` — pay is editable per-employer
  **data**, never code. §3 of this plan extends that model; it does not
  fork it.
- Finance rules outside this repo (the owner's Finance Project, STABILIZE
  phase): real income only, stability before leverage, the CNA fee and the
  emergency fund come before truck money. This plan spends no money the
  owner has not already ruled on.

---

## 0. The rules that bound every phase

### 0.1 Where we honestly stand today

Already true and usable (from `PROJECT_STATE.md`, the ELD roadmap's
"where we stand" checklist, and commits through 2026-11-07):

- **One driver, working for someone else.** The owner drives another
  owner-operator's second truck, leased on to a carrier whose authority
  the loads run under. He has a CDL and an existing LLC (name/EIN not yet
  recorded in the app). No truck of his own, no MC authority, no load-board
  accounts in his company's name, no broker relationships in his company's
  name, no employees. Every phase below is honest about which of those it
  needs.
- **The app as back office, live:** system of record for loads, trips,
  stops, trucks, trailers, drivers, brokers, customers, expenses, fuel,
  maintenance, documents, hours logs and paper logs; money truth in
  integer cents (operational revenue recognized on delivery, never called
  "profit").
- **Abel, the Telegram job brain** (Telegram + web, one shared brain):
  reads stored data through tools, drafts, stages **proposals**, and
  writes only on the owner's direct order in his own message or his yes on
  a stored proposal (`docs/ai-authority-matrix.md` §2, §5). Dispatch
  helper translates a forwarded dispatch message, reads who is asking,
  and drafts a reply in English and Spanish — drafts only, never sent.
  Nothing in the current tool registry sends a message to a third party
  or posts to a group.
- **Pay as data:** `employer_pay_profiles` (migration 00063, applied
  live) holds cents-per-mile, mile basis, worker type, and fuel payer as
  dated, editable rows — no employer named in code, no seed. Migration
  00074/00075 (applied live, verified 2026-11-07) added percent-of-load
  (`percent_of_load_bps`), pay-week end, statement weekday, and payday
  weekday, plus a per-load pay override (`loads.pay_override_cents`).
  The owner's current deal is entered as data: 55¢/mile, Sun–Sat week,
  Thursday statement, Friday pay; mile basis and worker type still
  visibly UNSET, so any figure that depends on them shows a range or a
  flag, never one confident number.
- **Tracking:** phone tracker reporting GPS positions to
  trucking.fly.dev, per-device keys (one key per install/driver, records
  tagged per key), server-side position record — a proof-of-miles trail.
  Telegram Live Location and the motion-based auto-switch to Driving
  (5 mph sustained, stamped `auto_motion`, with notice) are built; the
  Telegram webhook repair for button taps / edited messages is built and
  deployed (Fly v60) and still needs the owner's one tap on
  "Fix the connection" plus a live Live Location test to close.
- **Hours:** one server-side HOS read (carrier-anchored cycle engine:
  11 / 14 / 30-minute break / 70-in-8, 34-hour restart only when observed)
  used by Abel and Smart Path. Planning-grade and labeled as such. The
  truck's ELD (the carrier's) stays the legal record. **The app is not
  an ELD** — see §5.
- **Research engine:** scheduled watchers and briefings (EIA diesel,
  Federal Register — proven live from production 2026-11-06 — GDELT,
  weather, OpenStates), stored sourced briefings with a teaching
  takeaway, cost caps and the existing AI kill switches. The FMCSA
  Newsroom swap (Federal Register + Google News replacing the Newsroom
  line in `rss.ts`) was still partial at last check and is tracked
  elsewhere; this plan does not depend on it.
- **Isolation and safety rails:** company-scoped RLS, anonymous grants
  revoked (00067), per-capability switches in Settings plus a global
  switch, driving-safety lock that fails closed on unknown speed.

Not true yet, and this plan does not pretend otherwise:

- No load-board access of any kind — no accounts, no API, no scraping,
  no broker email address in the company's name.
- No agent cloud computer / browser. Abel runs server-side against the
  app's own data only.
- No sending to third parties at any level. No Level 5 (bounded
  autonomous execution) granted to any capability.
- No numeric escalation thresholds (e.g. "always escalate above $X").
  `docs/governance.md` is explicit: those must exist before any Level 5/6
  design is complete, and they must be calibrated on real operating data.
- No ELD functions: no engine (ECM) connection, no RODS logbook, no
  roadside transfer, no self-certification or FMCSA registration.
- "Machine learning" (learning from his approvals/corrections — outcome
  log, lessons, risk scoring, per `docs/design/bot-messages-and-safety.md`
  §6) is a proposal awaiting the owner's go-ahead, not built. Temporal
  reasoning's first slice (code-computed dates, `when_is` / `time_between`)
  is built and gated, not deployed.

### 0.2 Hard limits — the ladder's ceiling, in every phase

These come from the owner's 2026-10-31 ladder and were re-affirmed
2026-11-07. They are not phase-dependent and no phase below weakens them:

1. **Money never auto-sends.** No agent books a load, commits a rate,
   accepts a rate confirmation, agrees to accessorials, or moves money
   without the human approval step for that specific action.
2. **Signatures and terms never auto-send.** No rate-con signature, no
   broker/carrier agreement, no lease, no factoring agreement, no terms
   acceptance — ever — by an agent.
3. **Hours-of-service compliance never auto-sends.** No agent edits,
   certifies, or submits a log, and no dispatch decision may require a
   driver to break HOS to succeed. A plan that only works if the driver
   speeds, skips a break, or falsifies a log is a rejected plan, said
   plainly.
4. **Auto-send, when it ever arrives, is only for routine message classes
   the owner pre-approves by name** (the standing examples are check-ins
   and ETAs), each class with its own switch, a daily digest of everything
   sent, and instant revocation. A new class is a new owner decision.
5. **Autonomy is per capability and per relationship, not global.** The
   owner may grant a higher rung for status updates to one broker and
   keep every other broker at draft-only forever. The system must support
   that granularity; it is the design, not a settings extra.
6. **Every autonomy raise is a documented owner decision made before the
   change takes effect** (`docs/governance.md`: a Major Change), with the
   governance/matrix docs updated first — never granted silently because
   a feature turned out to be capable of more.

The ladder as this plan uses it, mapped to the governance levels:

| Rung in this plan | Governance level | Meaning |
|---|---|---|
| Observe | 1–2 | Agent reads and reports to the owner only |
| Recommend | 2 | Agent surfaces a scored recommendation with reasons |
| Draft | 3 | Agent prepares the exact message/action; nothing leaves |
| One-tap approve | 4 | Owner taps yes on that specific stored proposal; then it executes |
| Bounded auto-send | 5 | Only a named, pre-approved routine class, within written limits, own switch, daily digest |
| Narrow workflow | 6 | One well-understood workflow end-to-end, still under explicit limits — a future owner decision, not assumed in any phase below |

### 0.3 Design laws carried from the existing app

- **Phone-away while moving:** voice in/out, nothing to read or type at
  speed; forms lock; the Drive glance surface only. Every dispatcher
  interaction with a driving driver obeys this.
- **No UTC in anything user-facing, ever.** All times in the viewer's
  timezone (the owner's is America/New_York; each future driver's own
  timezone for their surfaces, home-terminal time for official HOS
  records per §395 — see the ELD roadmap, Part E).
- **Free-first for providers.** No paid tier if a free option exists; if
  none, the cheapest option, labeled honestly. This is also the
  employees-first economics in §3.3 working as intended.
- **Public repo hygiene:** no credentials, no personal data, no real
  screenshots in git. Load-board credentials follow the same rule as the
  Telegram secrets today: they live only as server secrets, never in the
  repo, never in a log line.
- **External content is untrusted input.** A load posting, a broker email,
  or a rate-con is data to validate — never instructions to the agent.
  Text inside a broker email that tells the agent to do something is a
  red flag to surface, not a command to follow.

---

## 1. Phases — from one driver learning the job to agent dispatch

Each phase states: **Build** (what gets built), **Needs** (data and
integrations it requires), **Unlocks** (what becomes possible that was not
before), and **Gate** (the owner decision or real-world milestone that
opens it — a phase does not start because the previous phase's code is
done; it starts because its gate happened).

### Phase 0 — Today: single driver, someone else's authority (current)

**Build:** Already built (see §0.1). The remaining work in this phase is
closing what is already in flight, not new dispatcher work: deploy and
live-verify the gated Abel/pay units, the owner's one tap on the Telegram
webhook repair + a rolling Live Location test, and FMCSA source
reconciliation. None of that is re-planned here.

**Needs:** Nothing new.

**Unlocks:** A trustworthy back office and a complete, honest record of
Phase 1 — every dollar, hour, load, and inspection logged — which is the
training data and the credibility base for everything after.

**Gate:** None — this is where we are. The phase ends when Phase 1's
habits (below) are simply how a week runs.

### Phase 1 — The back office that learns (still driving for Steven)

Purpose: while he is still learning the job on someone else's trucks and
authority, build everything that does **not** need his own authority:
the driver's own preference record, load *evaluation* (not load
*booking*), broker memory, and the paperwork/email drafting muscle —
all at Observe / Recommend / Draft rungs, all inside his own data.

**Build:**

1. **Driver profile — lifestyle and money goals as data.** A per-driver
   record (starting with one driver: him) that the future dispatcher
   will score against. Fields, all editable by the driver/owner, all
   visibly UNSET until set — the same honesty rule as pay terms:
   - Home base and home-time rule (e.g. "home every weekend," "out no
     more than N nights," target home dates) — free structure, not a
     single hardcoded pattern.
   - Lane preferences: preferred regions, hard no-go areas/cities,
     preferred freight types, equipment he is qualified/willing to run.
   - Money goals: weekly gross/pay target, minimum acceptable pay per
     mile and per day, minimum load rate the system should even surface,
     deadhead tolerance (max empty miles / max deadhead %).
   - Hard constraints: endorsements, physical limits, the 8pm–8am fast
     and sleep anchors the system already knows, anything that makes a
     load a hard no regardless of money.
   - This extends the existing "driver twin" idea (which today learns
     his *voice* from sent replies and draft edits) with the *dispatch*
     half: his take/pass patterns. Every load he is offered under Steven
     — taken or passed, and why, in his words — is recordable from the
     dispatch helper flow that already exists.
2. **Load evaluation without a load board ("bring your own load").**
   Today dispatch arrives as forwarded messages. Extend that flow: any
   load offered to him — pasted text, a forwarded message, a photo of a
   posting — is parsed into the **canonical load-candidate record** in
   §2.3 and scored by the engine in §2.4 against his driver profile, his
   live HOS clocks (the one server-side HOS read), the load's pay under
   his current pay profile, and Smart Path's route check. Output is a
   workup, not an action: take / pass / negotiate, with the reasons in
   plain language (pay per mile and per day, deadhead, HOS cost in
   hours, home-time impact, what it sets up next). This is the scoring
   engine the real dispatcher will use later, proven on real offers
   while a human (Steven's dispatch) is still the one actually assigning
   loads — so a wrong score costs an opinion, not a booking.
3. **Broker and facility memory, started now.** The broker scorecard
   read tool already exists. Phase 1 makes the *capture* habitual and
   structured: every broker/dispatcher/facility he touches under Steven
   gets a record — name, company, contact, how they pay and how fast,
   how they treat drivers, detention behavior, and his own notes. This
   is the name list the Vision doc calls his first asset under his own
   MC, and it cannot be backfilled later.
4. **Email drafting gym (no sending).** A company email inbox is a
   Phase 3 need, but the *drafting* patterns are Phase 1 work: Abel
   drafts broker-style emails from templates the owner approves (intro /
   packet request, rate negotiation, detention request, status update)
   against his real loads, stored as drafts he can edit. His edits are
   the training signal, exactly like dispatch replies today. Nothing is
   sent — there is no company inbox to send from yet, and no broker who
   should receive mail from a carrier that does not yet exist.
5. **Settlement truth loop.** Photograph every settlement statement;
   the existing pay-check surfaces (expected vs. received, grouped by
   pay week with statement/payday dates) close the loop. This produces
   the real numbers — actual CPM realized, actual deadhead paid or not,
   actual deductions — that calibrate the scoring minimums and, later,
   the Level 5 thresholds governance requires.

**Needs:** No new integrations. Uses what exists: dispatch helper,
Abel proposals, HOS read, Smart Path route check, pay profiles,
documents. One small schema addition (driver dispatch profile +
load-candidate record) — numbered against the then-current migration
chain at build time, never pre-numbered here.

**Unlocks:** A scoring engine with a track record the owner has watched
be right and wrong on real loads; a broker/facility memory with real
history; a driver profile that says, in data, what "a good load for me"
means. Without this phase, Phase 3's dispatcher would be guessing at
exactly the things this phase writes down.

**Gate:** Owner decision to build the driver-profile + load-candidate
units (ordinary build taps). No real-world milestone required — that is
the point of this phase. **Explicitly not gated on:** leaving Steven,
buying a truck, or activating authority.

### Phase 2 — Own-truck readiness and the authority-aging decision

Purpose: the money and paperwork phase. He is still driving for Steven
(or a successor arrangement) while the app becomes the buying and
readiness toolkit. No dispatch automation belongs in this phase; its
job is to make the Phase 3 gate a priced, dated decision instead of a
leap.

**Build:**

1. **Truck Fund and buying toolkit** (the Vision doc's Phase 2/3 work,
   restated as dispatcher-relevant): savings tracker against a target
   band labeled as an estimate to verify; used-truck listing watch with
   inspection checklist, title/lien and maintenance-history capture;
   total-cost model (truck + insurance year + authority costs + reserve)
   that refuses to call him "ready" on the truck price alone.
2. **Authority-readiness checklist in the app,** tracking the Florida /
   federal sequence with ⚠️ VERIFY markers carried from the Vision doc
   (figures are estimates until re-verified at build time): LLC active
   on Sunbiz → DBA/fictitious name → EIN confirmation → USDOT/MC filing
   (~$300) → BOC-3 (~$30–150) → insurance (the dominant cost, roughly
   $8–18k+/yr as a planning estimate) → UCR → IRP/IFTA → drug consortium
   / Clearinghouse enrollment. Each step: what it is, where it is filed,
   what it cost *him* (entered as real data), and its renewal date fed
   into the compliance calendar that already exists in design.
3. **The authority-aging decision tool.** The fresh-MC problem is the
   known trap: brokers commonly require an MC to be 90 days to 6 months
   old (some a year) before setup, and lapsed insurance *revokes*
   authority rather than pausing it. The app's job is the decision rule
   from the Vision doc, computed with his real numbers: activate early
   **only if** a truck date is within ~6 months **and** savings survive
   the full insurance year with the emergency fund intact. The tool
   shows the rule, the inputs, and the answer — the owner decides.
4. **Broker-readiness packet generator.** From data already in the app:
   authority letter (once it exists), W-9, insurance certificate,
   factoring/NOA details (once chosen), references list (Phase 1's
   broker memory). One tap assembles the packet a broker setup will ask
   for, so a setup takes minutes, not an evening. Draft in Phase 2;
   it becomes sendable only in Phase 3, at the Draft rung.
5. **Insurance and factoring shopping worksheets:** quotes recorded
   side-by-side with coverage, radius, cargo, and payment terms;
   factoring compared on fee %, reserve holdback, recourse vs.
   non-recourse, and broker quick-pay as the alternative — the
   comparison the owner will actually sign against, stored before he
   needs it under time pressure.

**Needs:** No external integrations. Optional read-only money visibility
(Plaid, per the Vision doc) only if the owner separately approves it —
the Truck Fund works from entered/settled data without it.

**Unlocks:** A dated, priced answer to "when do I activate, and what
does the first year actually cost," plus a packet that makes him look
established to the first broker who checks.

**Gate (real-world, his):** STABILIZE rules satisfied in order — CNA fee
handled, emergency fund on its path, truck savings accumulated from
*settled* income. The aging decision itself is a named owner tap,
recorded in the app. **This plan does not recommend activating authority
early; it builds the tool that prices the choice.**

### Phase 3 — Own authority, solo: the dispatcher is born (read-only first)

Purpose: first truck, his DBA, his MC. He is the only driver. The
dispatcher agent appears here — but it is born at the bottom of the
ladder and earns each rung in the open.

**Build, in sub-steps that each ship separately:**

- **3a. Company inbox + broker email at Draft/One-tap.** A real company
  email address (his domain or a business mailbox — provider is his
  pick, free-first). Abel gains the broker-email capability at Level
  3–4: it *reads* the inbox (with his connection approval), classifies
  each message (rate-con, setup paperwork, status request, payment,
  other), drafts the reply, and stages it as a proposal with the full
  text he will send. His yes sends that exact text — approval semantics
  are the matrix's §5, unchanged: one stored proposal, what he was
  shown, 2-hour validity, no inferred approval. Sending mechanics (SMTP
  / provider API) are built behind the proposal flow; Abel never gains
  a free-standing "send email" tool. Every sent email is stored against
  its load/broker thread (the `dispatch_exchanges` pattern, extended:
  incoming / draft / his edit / what was actually sent).
- **3b. Load-board reading, read-only (the cloud computer, first form).**
  The agent browser in §2.2 goes live for **one** board the owner
  chooses first (see §2.1 for the board order and why). It logs in with
  his credentials (server secrets only), runs his saved searches,
  extracts candidates into the canonical record (§2.3), and scores
  them (§2.4). It **cannot click book, bid, or accept** — those controls
  are out of scope for the browser profile in this sub-step, enforced
  by the task definition, not by hoping the model behaves. Output: a
  ranked shortlist in Telegram/the app, each with its workup and a
  deep link he opens himself if he wants the board's own page.
- **3c. Dispatch decision flow, solo.** For the top candidate he picks,
  Abel drafts the broker outreach (email per 3a, or a call script /
  talking points if that broker works by phone — the agent does not
  place phone calls in this plan at any phase; see §6). He approves,
  the email sends, the reply thread is watched, and a booked load flows
  into the existing loads/trips/stops system of record with its rate-con
  attached as a document. Booking itself — his signature on the
  rate-con — stays his, always (§0.2).
- **3d. Status updates at Draft/One-tap.** Check-ins, ETAs, arrival /
  departure, and POD-sent messages drafted from live position + HOS +
  appointment data, approved per message at first. This is the pool
  from which a later Bounded auto-send class may be chosen — chosen,
  not assumed (§4.2).

**Needs:** MC authority active and insured (Phase 2 gate passed);
company email; **one** load-board subscription in the company's name
(DAT or Truckstop are the realistic first boards — §2.1); broker setups
beginning (Phase 2 packet); factoring or quick-pay decision made per
load, recorded, never defaulted silently. ELD: the truck needs a
registered ELD or lawful paper-log basis from day one under his own
authority — the carrier's ELD from the Steven era does not follow him.
See §5 for what the app may and may not claim here.

**Unlocks:** He dispatches himself from the cab: the board is read for
him, the shortlist is scored against *his* life and *his* numbers, and
the broker thread is drafted in his voice — while every commitment
still passes through his tap.

**Gate:** Authority + truck + insurance are real (not planned), **and**
the owner names the first board and approves the credential handling in
§2.5. Sub-steps 3a–3d each take their own build tap; 3b additionally
requires the board's terms check in §6.1 to be answered for that board
before the browser is pointed at it.

### Phase 4 — The lease-on bridge (a fork, not a step)

This is not a phase everyone passes through; it is the documented
alternative if the fresh-MC wall (Phase 2) makes direct broker work
impractical at first: lease his truck on to an established carrier —
the arrangement Steven himself runs under — and let Road to Legacy be
the back office that audits it.

**Build:** Lease settlement auditing (photographed settlements checked
line-by-line against the lease's stated split and charge-backs, using
the existing settlement/paycheck machinery); a running "bridge price
tag" — what the carrier's cut has cost in total vs. what direct
authority would have paid in insurance/factoring — so the exit decision
is a number, not a feeling. Dispatcher work in this fork is Phase 1's
evaluation only: the carrier dispatches; the app evaluates and records.

**Needs:** A real lease and real settlements to audit (entered as data).

**Unlocks:** Revenue under his own truck while his MC ages (if he
activated it) and his inspection/safety record builds — the two assets
brokers actually check.

**Gate:** Owner decision, made on Phase 2's real numbers. The fork
rejoins at Phase 3 (solo dispatch under his own authority) or Phase 5
(first hire) when he rules the bridge has paid for itself.

### Phase 5 — First hired driver, second truck: dispatch becomes plural

Purpose: the mirror move — he hires a driver the way Steven hired him,
and the system built for one driver has to hold for two without him
becoming a full-time dispatcher on the phone.

**Build:**

1. **Per-driver everything, for real.** Per-driver logins/keys (the
   tracker key model extended to app accounts), per-driver pay profiles
   (§3.2), per-driver dispatch profiles (§2.4 — the second driver's
   home-time and lane data, entered with that driver, not assumed from
   the owner's), per-driver HOS reads in the dispatch scoring path.
   Driver data isolation is a hard requirement: a driver sees his own
   loads, pay, and clocks — not the fleet's, not another driver's.
2. **Driver-facing Abel (scoped).** Each driver gets Abel on Telegram
   scoped to his own records: his next load, his clocks, his pay-week
   running total, detention stamping, document photos in. A driver
   cannot approve company commitments; his approvals cover only his own
   operational confirmations (arrived, loaded, POD sent). Anything that
   commits the company routes to the owner.
3. **Owner dispatch console.** One surface (app first, Telegram digest
   second) showing both trucks: positions, clocks, current loads,
   scored next-load shortlists *per driver*, and every waiting proposal
   grouped by driver. The owner's yes remains the only booking
   authority; the console's job is that one yes is informed in under a
   minute, parked, on a phone.
4. **Hiring/compliance scaffolding:** driver qualification file
   checklist (CDL, medical card, MVR, road test, Clearinghouse queries),
   payroll rhythm (the Sun–Sat week / statement / payday pattern,
   generalized per driver), workers' comp and insurance additions
   tracked in the compliance calendar. The app tracks and reminds; it
   does not file government forms or give legal advice.
5. **ELD decision point (see §5).** With a hired driver, the ELD
   roadmap's trigger is expected to fire. Whether the company buys a
   proven registered ELD (the realistic path) or pursues this app's own
   hardware + self-certification track is a named owner decision with
   its own budget — dispatch features in this phase must work with
   *either* answer, reading hours from the app's HOS engine for
   planning while the legal record lives in the registered ELD.

**Needs:** Second truck + insurance for two power units; payroll
capacity (real money, STABILIZE/business rules — this phase is gated on
the business carrying it, not on enthusiasm); the hired driver's
consent-based profile data; ELD answer per truck.

**Unlocks:** The company earns while he sleeps or drives his own truck;
dispatch quality stops depending on him being parked and awake for
every decision.

**Gate:** Owner decision to hire (his tap, his interview, his call) +
Phase 3's solo dispatch proven over a real stretch of loads (the
scoring engine has a track record under his own authority, not only
under Steven's). If Phase 3 was skipped via the Phase 4 fork, the
bridge's audited record substitutes as the evidence base — named
explicitly in the gate decision, not assumed.

### Phase 6 — Multi-driver agent dispatch (the north star, bounded)

Purpose: with 3+ drivers (or 2 drivers and a proven Phase 5), the
dispatcher climbs — carefully, class by class — to the bounded
autonomy the north star describes.

**Build:**

1. **Fleet scoring and chaining.** The scoring engine (§2.4) runs per
   driver and then *across* the fleet: it stops scoring loads one at a
   time and starts scoring **chains** — the load after this load, the
   reload market at the destination, deadhead between chains, and
   home-time promises kept across the whole week, not per load. Two
   drivers must never be shortlisted onto the same load without the
   conflict being the headline of both workups.
2. **Bounded auto-send, first classes — only if the owner grants them.**
   Candidate first classes (each its own switch, its own owner tap,
   its own line in the daily digest): routine check-in/ETA messages to
   brokers already under a booked load; "still rolling, ETA unchanged"
   updates; POD-transmitted notices with the document attached. Each
   class definition states: exact template family, data it may fill in,
   brokers/relationships it applies to, hours it may send in, and what
   immediately revokes it (one wrong send, per the owner's standing
   rule that a stop order is verified, not assumed). Rate negotiation,
   booking, detention demands, and anything about money or terms are
   **not** candidate classes — §0.2, permanently.
3. **Exception-first digest.** The agent's daily report flips from
   "here is everything" to "here is what needs you": at-risk
   appointments, HOS conflicts tomorrow, a broker gone quiet, a load
   whose realized pay diverged from its score. Everything else is in
   the app if he wants it. Quiet hours (9 PM–6 AM Eastern pattern
   already in the matrix) hold everything except law/weather/safety.
4. **Back-office help seat.** The planning artifacts in §4.3 become
   shared with a human helper if he hires one (dispatcher/bookkeeper):
   role-scoped access, the same proposal/approval audit trail, no
   shared logins. The system a helper executes is the same system the
   agent executes — one set of rules, two kinds of hands.

**Needs:** Phase 5 proven; **numeric escalation thresholds set by the
owner** (governance requires them before Level 5 — e.g. minimum rate
the agent may even present as "routine," maximum deadhead it may plan
without flagging, the dollar variance that turns a settlement into an
exception); per-class auto-send grants recorded in `docs/governance.md`
+ the authority matrix *before* each class is built.

**Unlocks:** The north star as he stated it: agents run the automatable
jobs — boards read, drivers dispatched against their own lives and
goals, broker mail handled, everybody kept up to date — and his day is
relationships, capital, and the next truck.

**Gate:** Each auto-send class is its own gate. Nothing in Phase 6 is
a single "turn on autonomy" tap, and this plan contains no such tap.

### Phase 7 — Running from above (named, not planned in detail)

Multiple trucks, a dispatcher layer between him and daily noise, and —
only if he separately chooses it — evaluating the system as a product
for other owner-operators (explicitly out of scope in `docs/vision.md`
until the internal version is proven). This plan deliberately does not
design Phase 7; it notes the two decisions that will open it: (a) the
company's operating record is long enough that its own data answers
expansion questions, and (b) the owner rules on productization as its
own venture with its own legal review (ELD claims, data tenancy, and
load-board terms all change character when the user is not him).

---

## 2. The agent dispatcher — design

### 2.1 Load boards: which, in what order, and why

Order is driven by where a new, small carrier can actually get set up,
not by technical preference. Each board is onboarded **individually** —
its own terms check (§6.1), its own credential record, its own reader —
never as a bundle.

| Order | Source | Why this position | Access reality (verify at onboarding) |
|---|---|---|---|
| 1 | **DAT One (DAT TruckersEdge / Power)** | The largest spot-market board; the default first subscription for a new MC | Paid subscription in the carrier's name; web + mobile; API access is a separate, higher tier — assume browser reading until an API tier is proven available and worth it |
| 2 | **Truckstop.com** | The other major board; many brokers post to both, some only here; deduplication against DAT matters from day one | Paid subscription; similar API posture to DAT |
| 3 | **Amazon Relay** | Real program with its own portal/app and posted loads; the repo already names Relay parsers as an open item needing real messages | Enrollment is Amazon's decision, with its own performance/eligibility rules; treat as its own integration, not "another board" |
| 4 | **Broker direct portals / email offers** | Brokers he has relationships with (Phase 1 memory) send loads by email and their own portals (e.g. large brokerages' carrier portals) | No board subscription; the inbox reader in Phase 3a *is* this integration — an emailed load offer becomes a candidate through the same parser |
| 5 | **Direct shipper / load-matching programs** (e.g. digital freight networks that contract with small carriers) | Later, when the MC has history; these are applications and contracts, not subscriptions | Each is a signed agreement — owner signs personally (§0.2); the agent only reads what the agreement permits |

Explicitly **not** in scope: boards or sources his authority/equipment
does not qualify for; any source whose terms forbid the access method
being used (§6.1); "free load board" aggregator sites of unclear
provenance (data quality and terms are both unverifiable — the scoring
engine is only as honest as its inputs).

### 2.2 The cloud computer: what it actually is

The north star says "its own cloud computer." Concretely, in this
system's terms, that means:

- **A dedicated, isolated browser worker** running server-side (a Fly
  machine separate from the web app, so a browser crash or a blocked
  board session can never take the back office down), with a persistent
  browser profile per board — the way a human dispatcher's browser
  stays logged in — and **no other purpose**: it does not run Abel, it
  does not hold the database, it browses boards and returns structured
  candidates. One job, small blast radius.
- **Task-defined, not free-roaming.** The worker receives a job ("run
  saved search S for company C, return at most N candidates posted
  since T"), executes exactly that job's steps, and stops. It has no
  standing instruction to explore, no ability to change account
  settings, payment methods, or passwords, and — in Phase 3b — its
  task definitions contain no book/bid/accept actions at all.
- **Rate and rhythm discipline:** human-plausible polling intervals set
  per board (saved-search refreshes on a schedule the owner sees, not
  a continuous hammer), one session per board at a time, and a full
  stop on any CAPTCHA escalation, lockout warning, or terms banner —
  surfaced to the owner, never fought through automatically (see §6.1
  for the standing rule on blocks).
- **Everything it returns is untrusted input:** candidates are parsed
  and validated (dates parse, money is integer cents, lanes are real
  places) before they touch the database; a posting that fails
  validation is stored as a named exception, never repaired by guessing.
- **Audit:** every worker run logs board, search, time (Eastern),
  candidate count, and errors — the run log is a planning artifact
  (§4.3) the owner can read. Screenshots are evidence for debugging a
  broken reader only, kept out of the public repo, and deleted on the
  retention rhythm the owner sets.
- **Cost shape (employees-first, §3.3):** one small always-on machine +
  board subscriptions are the entire fixed cost of the dispatcher until
  Phase 6. No per-seat SaaS dispatch suite is bought to do what this
  worker plus Abel already do.

### 2.3 What the reader extracts — the canonical load candidate

Every source — board browser, emailed offer, pasted dispatch message —
produces the same record, so scoring never cares where a load came from:

- Broker: company, MC, contact name/email/phone; broker credit signal
  where the board shows one (days-to-pay / credit score as *displayed*,
  labeled with its source and date — a display, not a verification).
- Lane: origin/destination city + state, pickup and delivery windows
  (exact timestamps as posted, in the posting's timezone converted and
  labeled in Eastern for the owner), total posted miles if given.
- Load: commodity (as posted), weight, equipment type, length, team /
  hazmat / endorsement requirements, live load/unload flags.
- Money: posted rate (total, and per-mile as computed by us, labeled
  computed), fuel surcharge if broken out, detention/lumper/accessorial
  terms **as posted** (often absent — absence is recorded as "not
  stated," never filled in).
- Requirements and traps, verbatim where posted: appointment vs.
  first-come, TWIC, pallet exchange, "no touch" vs. driver unload,
  tracking-app requirement (a real cost/consent item — flagged, never
  silently accepted).
- Provenance: source board, search that found it, first-seen time,
  posting age at scoring time, and a dedupe key (broker + lane +
  windows + rate) so the same load on DAT and Truckstop is one
  candidate with two sources, not two opportunities.

A candidate is **not** a load. It becomes a load only through the
existing booking flow, after the owner's approval and a signed
rate-con. Candidates expire with their pickup window and are retained
(scored, taken/passed) as the outcome data Phase 1's learning needs.

### 2.4 Scoring: against a life first, then against money

Scoring is two gates, in this order, and the order is the product:

**Gate 1 — hard filters (any one kills the candidate, reason named):**

- **HOS feasibility:** using the one HOS read — can this driver legally
  pick up, drive, and deliver inside the windows, with the 30-minute
  break and a lawful rest placed, and still have a legal next day? If
  it only works by breaking a clock, it is out, and the workup says
  which clock killed it. (Planning-grade, labeled; the ELD/paper record
  governs the real day — §5.)
- **Home-time promise:** does accepting break the driver's home-time
  rule or a specific home date in his profile? A promise already made
  to a driver outranks a rate.
- **Qualification:** equipment, endorsements, weight, and facility
  requirements the driver/truck does not meet.
- **Driver hard no-gos:** areas/freight in the profile's hard list.
- **Broker floor:** broker below the owner's credit/payment floor, or
  on his do-not-use list (Phase 1 memory), or a duplicate of a load
  already worked.

**Gate 2 — scored ranking (survivors only), each factor shown, no
single opaque number without its parts:**

- **Pay truth:** projected driver pay under the applicable pay profile
  (§3) *and* company gross on the load; pay per loaded mile, per
  **all** miles (deadhead counted), and per day consumed — the three
  numbers side by side, because a great per-mile load that eats two
  days can be a bad load.
- **Deadhead and positioning:** empty miles to pickup, and the
  destination's reload reality (recent candidate density and realized
  rates out of that market from our own records — our data first,
  board display second, both labeled).
- **Time cost:** HOS hours the load consumes, stated next to its pay —
  the standing owner requirement that pay answers carry their hours
  cost, applied to dispatch.
- **Lifestyle fit:** nights away vs. the driver's pattern, weekend
  impact, lane preference match — scored from the profile, and a
  mismatch *lowers* the rank even when the money is good. The workup
  must be able to say "best money this week, and it costs you the
  weekend at home" in one breath.
- **Relationship value:** a broker he is building history with (Phase 1
  memory) gets a visible, capped nudge — labeled as such, never hidden
  inside "the score."
- **Detention and friction history:** this broker/facility's recorded
  behavior adjusts expected time, using our records only.

Output per candidate (the **dispatch workup**): verdict (Strong take /
Workable / Pass), the Gate 1 pass, the Gate 2 parts, the one-line
"what this load does to your week," and the draft next action (broker
email draft, or "call — here's the script"). The owner can always see
*why*; a score he cannot interrogate is a score he should not trust,
and the system is designed to be argued with — his override and his
reason are recorded and become outcome data.

### 2.5 Credentials: how board access would work

- Board accounts are the **company's** accounts, opened by the owner in
  the company's name, paid from the company's money. The agent never
  opens an account, never agrees to board terms (the owner clicks his
  own signup — §0.2), and never touches payment settings.
- Passwords live in the same secret discipline as today's Fly secrets:
  server-side only, never in the repo, never in a log, never shown back
  in chat or in the app. The browser worker receives them at run time
  from the secret store; they are not stored in the browser profile in
  readable form beyond what the board's own "stay logged in" session
  requires.
- **Session-first, password-last:** the worker normally rides the
  board's own persistent session (the human pattern). A forced
  re-login, a password prompt appearing unexpectedly, or any MFA
  challenge **stops the run and asks the owner** — the agent does not
  receive, store, or enter one-time codes on its own; if MFA is
  unavoidable for a board, that board's onboarding decision includes
  how the owner will approve logins, or that board stays manual.
- One board, one profile, one worker identity. If a board offers a
  legitimate API or data feed tier, prefer it over browsing at the
  next renewal — browsing is the fallback for boards that offer a
  small carrier no other door, and §6.1 governs whether it may be used
  at all.

### 2.6 How a dispatch decision reaches a driver

The path is the same at every phase; only the approver changes:

1. **Candidate scored** (§2.4) → workup stored.
2. **Proposal to the approver:** solo (Phase 3) the approver is the
   owner-driver himself — workup + draft broker outreach arrive via
   Abel on Telegram and in the app, one stored proposal, matrix §5
   semantics. With hired drivers (Phase 5+), dispatch proposals route
   to the **owner**; the driver receives only the *outcome* (his next
   load, with pickup/delivery, rate-con details he needs, and his
   projected pay on it) — a driver is never asked to approve a company
   commitment, and never learns another driver's numbers from a
   dispatch message.
3. **Approval executes exactly what was shown:** the broker email as
   drafted-and-edited, to the address shown, on the thread shown.
   Anything else — a changed rate, a new accessorial, a different
   window in the broker's reply — is a **new** proposal, never an
   amendment under the old yes.
4. **Driver notification** is a separate, driver-scoped message
   (Phase 5+): assignment, windows, facility notes from memory, and
   the "if this goes wrong, do this" line. While he is moving, it
   waits or arrives as voice-grade summary per the phone-away law;
   the detail waits for a stop.
5. **En route,** status drafts (or, in Phase 6, granted auto-send
   classes) keep broker and owner current from position + HOS data;
   an exception (late, breakdown, detention past the free time) is
   escalated to the owner immediately, with a draft detention/broker
   message attached — the agent reports the problem and proposes the
   words; it does not improvise commitments about it.

---

## 3. Pay engine — alignment and extension

### 3.1 What exists (do not rebuild)

The pay-as-data model is the foundation and it is already right:

- Dated `employer_pay_profiles` rows per company; a change starts a new
  dated row, history is never edited away. Money is integer cents;
  percent is basis points.
- Pay for a load = mile part (CPM × the miles the basis counts) +
  percent part (% × the load's gross rate), each present only when set;
  a per-load override wins and is labeled "set by you."
- UNSET basis/worker type ⇒ range or refusal, never a guessed figure.
  The 2026-11-07 pay-zero root-cause fix (a fuel-payer edit silently
  wiping the rate) and its guards are the standing lesson: any pay
  change shows before → after, and a change that would zero a money
  field says so before it can be approved.
- Pay-week machinery: configurable week end, statement weekday, payday
  weekday; Money → Paychecks groups finished loads by pay week with
  should-be vs. statement-received and short/unpaid flags; projected
  pay shows this week's running total. Settlements are the final
  number; projections are labeled projections.
- Abel tools: `projected_pay` (read), `set_pay_terms` and the pay pin
  (always proposal), `explain_load_pay` (states pay **and** its HOS
  hours cost), settlement extraction and paycheck check.

### 3.2 How the model extends — three pay eras, one schema shape

The extension rule: **the profile gains a subject (who is being paid,
under what relationship), not a new engine.** Concretely, as design
direction for the build phases (each is its own gated unit):

- **Era 1 — he is paid by an employer (today).** Profile subject =
  employer deal (Steven's carrier today). Already built. Phase 1 adds
  nothing except realized-rate reporting from settlements.
- **Era 2 — he pays himself under his own authority (Phase 3).** Two
  linked views of the same loads: **company gross** (load rate −
  factoring/quick-pay cost − fuel − tolls − per-load costs, computed by
  the existing load-economics machinery, D-unit `GET /loads/[id]/economics`
  and contribution-margin work) and **his driver pay** — a pay profile
  whose subject is *himself as driver*, still CPM-first per the north
  star ("per mile driven no matter what"), with the percent part
  available the day he wants his own deal to mirror a lease split. The
  owner-operator truth the app must show plainly: driver pay is money
  the company pays him; company margin is what is left for the truck,
  taxes, and growth. Conflating them is how owner-operators go broke
  feeling rich — the two numbers stay separate on every surface.
- **Era 3 — he pays drivers (Phase 5+).** Profile subject = each hired
  driver, dated rows per driver, same fields plus the Era-3 additions
  below. A driver's profile is visible in full to that driver (his own)
  and to the owner; never to other drivers.
  - **Base:** CPM on **all miles driven** as the default basis the
    north star names ("per mile driven no matter what") — with the
    basis still explicit data per driver (loaded / all / practical),
    because a driver must be able to read his own deal and see which
    miles count. If a specific driver's deal is percent-of-load, the
    percent part carries it — the schema already holds both, and a
    mixed deal (CPM floor + percent upside) is expressible as both
    parts set, with the floor logic stated in the profile notes and
    computed in code, not in a comment.
  - **Guarantees as data:** weekly minimum guarantee (if offered) as a
    profile field with its conditions stated (available all week, no
    refused loads) — computed by the paycheck machinery as a top-up
    line, labeled, never buried.
  - **Bonuses as data (the bonus catalog):** each bonus is a dated,
    named profile/load rule with an amount (cents or bps), a trigger
    the system can *verify from records*, and the pay week it lands in:
    safety/inspection bonus (clean roadside inspection logged),
    fuel bonus (MPG vs. truck baseline from fuel records), on-time
    bonus (appointment performance from load timestamps), detention
    passed-through (detention collected from the broker, shared at a
    stated %), weekend/home-time-trade bonus (driver *volunteered* for
    a profile-conflicting load — the system's way of paying for the
    lifestyle cost instead of hiding it), referral and longevity
    bonuses (dates and amounts, owner-set). A bonus the system cannot
    verify from records does not auto-calculate; it appears as a
    proposed line the owner approves — bonuses are money, §0.2.
  - **Deductions stay boring and visible:** only dated, named,
    driver-acknowledged items (e.g. an advance, with its repayment
    split across weeks as data). No deduction category may be created
    by the agent; the agent may only *apply* the catalog the owner and
    driver have on record. Advances are tracked as their own lines —
    "not computed: advances" is an open item today and closes here.
  - **Payday truth:** the existing week/statement/payday machinery
    generalizes per driver unchanged in shape; a driver's Money view
    shows his running week, his projected payday total with its parts
    itemized (miles / percent / bonuses / guarantee top-up /
    deductions), and after payday, the paycheck check against what
    actually landed — the same honesty loop he uses on Steven today,
    now run by him, for his driver, in the open.

### 3.3 Employees-first, as mechanics — not a slogan

The north star's economics ("cut cost in infrastructure, put the money
into trucks and employees") become these concrete rules. Items marked
**owner decision** are proposals in this plan, not rulings — they take
effect only by his tap, recorded like any other standing rule:

1. **Infrastructure has a visible budget line.** Every recurring tool
   cost (Fly machines, board subscriptions, email, any API) is recorded
   as a company expense in the app, in the same Money view as fuel and
   tolls — the agent's own cost is a number he can see monthly, per
   truck. A dispatcher that cannot state its own cost cannot claim to
   be cheap.
2. **Free-first is the cost policy (already standing).** Any *new*
   paid infrastructure requires the owner decision that no free /
   cheaper option serves — the same rule the repo already runs on.
   **Owner decision proposed:** an infrastructure ceiling stated as a
   % of gross or a $/truck/month cap, reviewed quarterly, with any
   breach surfacing as an exception (§2.6 style) rather than a quiet
   renewal.
3. **No per-driver SaaS tax.** A new driver costs the company a truck,
   insurance, and his pay — not a new stack of per-seat subscriptions.
   If a proposed tool charges per seat, that fact is the headline of
   its proposal, and the default answer is build-on-what-exists.
4. **Savings have a named destination.** When the agent's automation
   measurably replaces a paid service or a human dispatch fee (the
   Phase 4 bridge makes this number real: a carrier's dispatch % is a
   known price), the comparison is reported in the monthly close:
   "dispatch cost this month: $X (infrastructure) vs. $Y (what the
   bridge charged per load)." Where the difference goes — truck fund,
   driver bonus pool, reserves — is the owner's allocation decision;
   the system's job is that the number exists and is true.
   **Owner decision proposed:** a stated split (e.g. a fixed % of
   verified dispatch savings funds the bonus pool in §3.2) so
   "employees-first" is a formula a driver could audit, not a sentiment.
5. **Driver pay is computed before company margin on every load
   workup.** In §2.4's scoring, the driver's projected pay line appears
   ahead of the company's margin line — an ordering choice that makes
   the priority structural. A load the company loves and the driver
   loses on must say so in that order.
6. **Nothing about a driver's pay is hidden from that driver.** His
   profile, his per-load pay math, his bonus triggers and whether they
   fired, his deductions — all readable by him in his own app view.
   Employees-first that a driver cannot verify is marketing.

---

## 4. The agent back office

### 4.1 What exists today, via Abel

- Conversational record-keeping on Telegram + web (proposals, approvals
  per matrix §5, confirmations that say where a thing was saved).
- Dispatch helper: forwarded-message workup + bilingual draft replies.
- Scheduled jobs that report to the owner only: research watchers and
  briefings, game plan, maintenance watch, weekly pay report, logging
  reminders, memory consolidation (staged, approved before it lands).
- Document intake: photos/paperwork classified, extracted into fields,
  filed by proposal; settlement extraction; paper-log reading with the
  review screen.
- Broker scorecard and thread/people memory (who asked what, what is
  still open), with `list_open_threads` as the "who are we waiting on"
  view.

None of it sends to a third party. That is the correct starting line,
and Phase 3a is the first, deliberate crossing of it — by email, at
Level 4, one proposal at a time.

### 4.2 Broker email — the lifecycle, by rung

| Stage | Rung | What happens |
|---|---|---|
| Inbox read + classify | 2 (recommend) | Abel reads the company inbox, classifies, files against load/broker, summarizes for the owner. No reply drafted yet for low-confidence classifications — they are listed as unclassified, never guessed into a thread. |
| Draft | 3 | Reply drafted in his voice (driver-twin patterns + his Phase 1 edits), stored with its thread, shown with the exact recipient and subject it would carry. |
| One-tap send | 4 | His yes sends that exact text. Send result (accepted by the mail provider / bounced) is reported back; a bounce is an exception, not a silent failure. |
| Bounded auto-send | 5, Phase 6 only | Only named routine classes (§1 Phase 6), only to relationships he names, templates he approved, daily digest, per-class switch. A broker's reply that changes money/terms/windows instantly returns the thread to Level 4 — auto-send may never negotiate. |
| Never | — | Rate acceptance, rate-con signature, agreements, detention *demands* with dollar commitments, anything signing or binding the company. Draft + his hand, forever (§0.2). |

Thread discipline: one thread per load/broker matter; Abel's summary
of a thread always names what is still open and who owes the next move;
an unanswered broker thread past an owner-set interval surfaces in the
digest (the "keeping everybody up to date" job includes noticing when
somebody else has *not* kept us up to date).

### 4.3 Status updates and planning artifacts

**To brokers** (per load, from live data): check-in with position,
ETA with its basis ("ETA 2:40 PM Eastern, from current position and
remaining drive time"), arrival/departure, loaded/empty, POD
transmitted with document attached, detention clock started/stopped
(stamped, as the detention tool already does). Drafted at Phase 3d,
auto-send candidates at Phase 6 only as in §4.2.

**To drivers** (Phase 5+): next-load assignment (§2.6), changes to a
load already assigned (always a named change, never a silent edit —
the driver sees "changed: delivery window moved," not a quietly
different load), pay-week running totals on request and at week close,
and home-time countdowns that agree with the dispatch profile the
loads were scored against.

**To the owner:** the daily digest (what the agent did, what is
waiting on his yes, what is at risk tomorrow — exceptions first at
Phase 6), the weekly pay/settlement reconciliation, and the monthly
close (infrastructure cost, dispatch-savings comparison §3.3,
bonus-pool funding if granted, per-truck margins).

**Planning artifacts the system keeps, each already rooted in an
existing surface:** dispatch workups (§2.4) and their outcomes; the
load-candidate archive (scored, taken/passed, realized pay vs. score);
broker/facility scorecards grown from real threads; the compliance
calendar (authority renewals, insurance, IRP/IFTA, medical cards,
DQ-file items); the browser-worker run log (§2.2); and the outcome log
proposed for Abel's learning (§0.1) — which, if the owner approves it,
doubles as the dispatcher's training record: every scored load's fate,
in one place, auditable.

### 4.4 What each phase adds to the back office (summary)

- **Phase 1:** driver dispatch profile, candidate records + workups,
  broker-memory capture habit, email draft templates (unsent).
- **Phase 2:** readiness checklist, aging decision tool, packet
  generator, shopping worksheets.
- **Phase 3:** company inbox read/classify, broker email at Level 4,
  board reader (read-only), solo dispatch flow, status drafts.
- **Phase 4 (fork):** lease settlement audit + bridge price tag.
- **Phase 5:** driver-scoped Abel, owner dispatch console, DQ-file and
  per-driver pay surfaces.
- **Phase 6:** chain scoring, granted auto-send classes, exception-first
  digest, helper seat with role-scoped access.

---

## 5. Consistency with the ELD compliance roadmap

This plan and `docs/eld-compliance-roadmap.md` must never contradict
each other. The binding points:

1. **The app is not an ELD at any phase of this plan** until the ELD
   roadmap's own parts are completed: engine-connected hardware (Part
   B), automatic recording (Part C), RODS logbook (Part D), back office
   (Part F), roadside transfer (Part G), malfunctions (Part H),
   integrity (Part I), and self-certification + FMCSA registration
   (Part J). No dispatcher feature may be described — in the app, to a
   broker, or to a driver — as an ELD function.
2. **Dispatch plans with the HOS engine; the legal record governs.**
   §2.4's HOS gate uses the app's one HOS read and is labeled
   planning-grade. The driver's actual duty record lives in the
   registered ELD for that truck (the carrier's today; a Phase 3/5
   decision under his own authority) or lawful paper logs where they
   apply. If the two disagree, the plan is wrong, not the record — the
   workup says so and re-plans.
3. **The motion auto-switch is not a compliance shortcut.** The
   existing 5-mph auto-switch to Driving is a deterministic app rule
   with notice, consistent with the ELD roadmap's Part C direction —
   but until Part C is built on ECM data, it remains an app
   convenience over GPS, and no phase here promotes it to a legal
   recording.
4. **Dispatch discipline is an ELD-roadmap requirement, not a
   nicety:** the roadmap's Part K already states dispatchers see hours
   before assigning loads. §2.4 Gate 1 *is* that requirement,
   implemented as a hard filter. A future dispatcher who could override
   the HOS gate would violate both documents; there is no override in
   this design — only the owner's decision not to take the load, or to
   re-plan it lawfully (relay, reschedule with the broker by approved
   email, or pass).
5. **Per-driver keys → ELD identity.** The roadmap's Part F/I direction
   (unique driver accounts, no shared logins, per-driver keys growing
   out of the tracker's device-key model) is the same identity work as
   Phase 5's per-driver everything. Build it once, to the ELD
   roadmap's standard (authenticated identity, separate permissions,
   driver data invisible to other drivers), even before any ELD
   hardware decision — rework here would be the expensive kind.
6. **Retention:** dispatch records, rate-cons, BOLs, and emails are
   supporting documents (§395.11 in the roadmap's Part F). The back
   office retains them at least 6 months alongside the log records
   they support, with the backup copy the roadmap requires — retention
   settings are the owner's, deletion stays proposal-only, and nothing
   in the candidate archive (§2.3) may be purged on a rhythm shorter
   than the supporting-documents floor for booked loads.

---

## 6. Risks and unknowns — plainly

### 6.1 Load-board terms of service on automation (the biggest unknown)

- **What we do not know:** whether DAT's, Truckstop's, or Relay's
  current terms permit automated browsing/scraping of their boards
  under a small-carrier subscription, permit it only via an official
  API tier, or forbid automated access outright. Terms change; memory
  and other companies' habits are not evidence. **No board reader is
  built until that board's current terms have been read, in full, for
  the exact access method proposed, and the answer recorded in this
  repo** (a dated note per board: what the terms say, quoted, and which
  method they permit). If the answer is "API tier only," the choice is
  the API tier's real price vs. that board staying manual — an owner
  decision with the price named. If the answer is "forbidden," the
  board is read by a human, and the agent's job for that board is
  scoring what the human pastes in (Phase 1's bring-your-own-load flow
  already covers it).
- **Standing rule on blocks:** a CAPTCHA, lockout, or automation
  warning stops the worker and surfaces to the owner. The worker never
  rotates identities, solves CAPTCHAs by third-party services, or
  otherwise disguises itself. An account ban would cost the company
  its board access at the exact moment it can least afford it; the
  reader's caution *is* the business case.
- **Account-sharing trap:** board subscriptions are typically licensed
  per user/company. The worker browses as the company's own account —
  the owner's own login, on the company's behalf — which is precisely
  the fact pattern the terms check must clear. "Our agent did it" will
  not read as different from "we did it," to the board or to a broker.

### 6.2 Credential and account security

- Board, email, and factoring credentials concentrate exactly the
  access a thief would want: book freight in the company's name,
  redirect its pay. Controls carried from §2.5: server-secret storage
  only; worker gets credentials at run time; no credential in the app
  UI, logs, or repo; MFA challenges stop the run for the owner; a
  **credential incident playbook** is a Phase 3 deliverable *before*
  the first board login: how the owner revokes sessions, resets
  passwords, and notifies brokers, in that order, from his phone.
- Email is a signing surface in practice: a compromised inbox can
  "agree" to rates. The Level 4 proposal flow is also a security
  control — mail sent by the agent exists only as approved proposals,
  so any sent mail outside that log is by definition suspicious, and
  the sent-log is checkable in the digest.
- Double-brokering / impersonation fraud cuts both ways in this
  industry: the agent must verify broker identity on *first* contact
  per thread (MC lookup from the research engine's FMCSA sources, callback
  to the number on record, not the number in a suspicious email)
  before any packet containing the company's documents is drafted for
  sending. The packet generator (§1 Phase 2) therefore drafts — the
  owner approves the *recipient* as much as the content.

### 6.3 HOS and compliance boundaries

- Planning-grade hours can be wrong: unlogged duty, a paper-log day
  not yet photographed, a timezone edge. Gate 1 fails **closed**: if
  hours are stale or unknown, the candidate is flagged "hours
  unverified" and cannot be presented as a clean Strong take — the
  same fail-closed rule the driving-safety lock already uses.
- The agent never advises a driver how to "make" a load fit the clocks
  by reclassifying time, and never proposes edits to duty records.
  Its only lawful moves are: plan within the clocks, propose a
  reschedule to the broker (owner-approved), or pass.
- Personal conveyance, yard moves, split-sleeper, and adverse-driving
  extensions are real rules with real conditions (ELD roadmap Part E);
  until the HOS engine implements each *with* its conditions, scoring
  treats the plain limits as the limits. A load that needs an
  exception to work is scored as not working, with the exception named
  as the owner's human judgment call — his to make with the real ELD
  in front of him, never the agent's to assume.
- Intrastate/Florida-only work has its own HOS/ELD equivalents (ELD
  roadmap Part A); lane scoring for intrastate loads must use the
  ruleset the load actually runs under, labeled — a Phase 3 checklist
  item when his authority's operating pattern is known.

### 6.4 When the agent is wrong — failure modes, named in advance

| Failure | What it looks like | Designed response |
|---|---|---|
| Wrong score (bad load ranked Strong take) | He takes it on the workup; realized pay/time diverges | Outcome is recorded against the workup (§4.3); realized-vs-scored variance is a digest line; repeated variance on a factor (e.g. a market's reload reality) visibly down-weights that factor until re-earned. His override-with-reason is captured the same way — the system learns from being wrong in the open or it does not learn at all. |
| Stale board data | Candidate already covered/booked by someone else | First broker reply revealing it closes the candidate as "stale"; staleness rate per board is a run-log metric; a board whose data is chronically stale gets its polling rhythm and its ranking trust reduced, and the owner sees both. |
| Misread posting (parser error) | Weight, window, or rate extracted wrong | Validation (§2.2) plus the workup shows extracted fields *as extracted* with provenance; the broker draft never restates money/windows the parser is unsure of — uncertainty is quoted, not smoothed. A confirmed misread is a named defect with a regression test, per this repo's pitfall-hunt discipline. |
| Email sent to the wrong thread/recipient | A draft approved against the wrong broker context | Approval shows recipient + thread summary as first-class fields (§4.2); sends are logged and in the digest the same day; the playbook response (immediate correction email, drafted, owner-approved) is a template, prepared before it is ever needed. |
| Auto-send class misfires (Phase 6) | A check-in goes out with a wrong ETA | One wrong send revokes the class pending the owner's re-grant (standing rule, §1 Phase 6); the class's digest line shows every send with its data basis, so a wrong number is traceable to the position/HOS input that fed it. |
| Agent confidently wrong about identity | Broker impersonation succeeds in drafting stage | §6.2 verification before any packet draft; the draft itself names how the broker was verified ("MC matches FMCSA record; callback number from our Phase 1 record") so the owner approves the verification, not just the words. |
| Worker/browser breakage | Board changes its layout; reader returns garbage or nothing | Reader fails loudly (zero candidates + a broken-reader exception), never fabricates postings; Phase 1 manual flow is the permanent fallback, so a broken reader degrades the company to Phase 1, not to zero. |
| Cost creep | Subscriptions + machines quietly grow | §3.3's visible infrastructure line + proposed ceiling; the monthly close names every recurring cost with its per-truck figure. |
| The owner stops checking | Approvals become rubber stamps (the human failure mode every approval system has) | Proposal design fights it: before → after on anything monetary, the one-line lifestyle/money consequence on every workup, expired proposals die instead of queuing silently, and deletes/money/terms never batch into a single yes with routine items (already matrix §5 discipline). If he notices himself tapping without reading, the honest fix is fewer proposals (higher shortlist threshold), not faster tapping — a setting the system exposes. |

### 6.5 Business unknowns this plan cannot design away

- **Fresh-MC load access** may be thin for months regardless of tooling
  (Phase 2/4 exist because of this). The dispatcher cannot score loads
  that brokers will not offer a new MC; expectations for Phase 3's
  first quarter should be set on that basis.
- **Insurance cost and radius** will shape which lanes are even
  insurable/profitable; scoring minimums are placeholders until his
  real policy exists.
- **Factoring dependence:** if cash flow forces factoring, its fee is
  a per-load cost in scoring from the first factored load — a load
  that only pencils *before* the factor fee does not pencil.
- **His time is the scarcest input.** Every phase was ordered so the
  phase he is *in* saves him time before the next phase asks for
  decisions. If a build stops saving time, that is a defect report,
  not a roadmap debate.

---

## 7. Start now vs. must wait

### 7.1 Buildable / preparable during the current phase (driving for Steven)

Nothing here needs his authority, a truck, a board account, or an
employee. Ordered by value per hour of his attention:

1. **Driver dispatch profile (Phase 1.1)** — the data model + Settings
   surface + Abel capture ("remember: no loads that end in Atlanta on
   a Friday"). His profile entries take minutes across a week of real
   offers and define scoring forever.
2. **Load-candidate record + scoring workup on forwarded offers
   (Phase 1.2)** — parser reuses the dispatch-helper intake; scoring
   reuses HOS read, pay profile, Smart Path. Immediate payoff: better
   answers about the loads Steven's world already offers him, and a
   proven engine before money rides on it.
3. **Broker/facility memory capture habit (Phase 1.3)** — mostly
   product polish on existing records + Abel prompts at load close
   ("anything worth remembering about this broker?"). Starts the asset
   compounding now.
4. **Email draft templates + his edit history (Phase 1.4)** — drafts
   only; the voice training and template library are ready the day the
   company inbox exists.
5. **Settlement truth loop discipline (Phase 1.5)** — surfaces exist;
   the work is the habit + closing the gaps his real settlements
   expose (advances line, deduction lines).
6. **Authority-readiness checklist + packet skeleton (Phase 2.2/2.4)**
   — checklist and packet *structure* now; dollar figures re-verified
   when entered; the aging decision tool once real insurance quotes
   exist to feed it.
7. **Terms research for §6.1** — reading DAT/Truckstop/Relay terms
   costs no account and can be done any time; the dated per-board
   notes can exist a year before the first login, and they decide
   whether 3b is a browser, an API, or a manual paste-in — before a
   dollar of subscription is spent.
8. **ELD identity groundwork (§5.5)** — per-driver account/permission
   shape designed to the ELD roadmap's standard, usable by Phase 5
   and required by Part F either way.

### 7.2 Must wait — and what exactly it waits for

| Work | Waits for | Why |
|---|---|---|
| Company inbox + broker sending (3a) | Authority active (or at minimum a real company identity brokers should hear from) + owner-approved email provider + connection | Mail from a carrier that does not exist yet creates confusion and a paper trail in the wrong name |
| Board accounts + reader (3b) | His MC + first board chosen + §6.1 terms answer for that board + credential playbook (§6.2) | Subscriptions are in the carrier's name; automation method is a terms question, not a preference |
| Any Level 5 auto-send class | Phase 5 proven + owner-set numeric thresholds + governance/matrix updated first | Governance forbids Level 5 design without thresholds; trust is earned per class |
| Per-driver pay/bonus computation for employees (§3.2 Era 3) | A hired driver with a real, signed deal to encode | Encoding a hypothetical deal invites treating it as a promise; profiles are created *with* the driver at hire |
| ELD hardware/self-certification track | The Phase 5 trigger decision (buy registered vs. build) + budget | The ELD roadmap's scope is a product program of its own; starting it early starves the phases that earn the money to fund it |
| Chain/fleet scoring (Phase 6.1) | 2+ drivers running Phase 5 dispatch | Chaining one driver's loads is Phase 3 workup context; fleet chaining with one truck is fiction |
| Productizing for other carriers (Phase 7) | Owner's separate venture decision + legal review | Changes every terms, tenancy, and ELD-claims assumption in this plan |

---

## 8. Decisions this plan needs from the owner to sharpen it

These are not blockers for Phase 1 — Phase 1 is buildable on the
record as it stands. They are the points where his answer changes the
design, listed so they can be decided when they become cheap to decide:

1. **First board:** DAT first (this plan's assumption) or Truckstop
   first — and is Amazon Relay pursued as a program in its own right
   at Phase 3, or only if spot-market volume disappoints?
2. **Company email:** his own domain vs. a business mailbox provider —
   and does Abel's inbox access start read/classify-only for a proving
   period before the first send class is granted?
3. **Scoring posture:** when money and lifestyle conflict, the default
   ranking already favors the hard filters absolutely and lifestyle
   over money inside Gate 2 (§2.4). Does he want a "money month"
   switch — a dated period where he pre-declares lifestyle yields to a
   stated money goal — as data, or should every exception stay a
   per-load override in his own words?
4. **The employees-first formula (§3.3 item 4):** does he adopt a
   stated dispatch-savings split to the bonus pool, and at what %?
   (Effective only when there are employees; deciding the *shape* now
   costs nothing and makes Era-3 pay design concrete.)
5. **Infrastructure ceiling (§3.3 item 2):** adopt a cap (% of gross or
   $/truck/month), and the review rhythm?
6. **Auto-send appetite, stated early so Phase 3 is built to fit:**
   are check-in/ETA/POD classes the intended first grants at Phase 6,
   or is his ceiling "drafts forever, my tap is the product"? Either
   answer is buildable; they produce different Phase 3 plumbing
   (template families and data-basis logging matter much more if
   auto-send is ever coming).
7. **"Machine learning" go-ahead** (already open in
   `docs/design/bot-messages-and-safety.md` §6): the outcome log is
   load-bearing for §2.4's learning claims — Phase 1.2 should include
   it if he approves it, and this plan's scoring-improvement promises
   shrink honestly if he does not.
8. **ELD posture at his own authority (Phase 3):** buy a proven
   registered ELD per truck (plan's assumption) with the app as the
   planning/back-office layer — or is the app's own ELD track (ELD
   roadmap Parts B–J) an intended Phase 5 program he wants costed in
   the next revision of this plan?

---

## 9. How this plan itself gets built — gating discipline

- This document lands on a feature branch; merge and any deploy are
  the owner's taps, per the standing rule for this repo.
- Each build item named above becomes its own design note or design
  section *before* code, per `CLAUDE.md`'s mandatory workflow
  (spec → design → govern → contract → implement → gate), its own
  branch, its own full gate (tsc, eslint, vitest, next build) with
  persisted logs, and its own owner tap to merge. Migrations are
  numbered against the live chain at build time (through 00075 as of
  this writing) and, once applied, are frozen — corrections get a new
  number (the 00074/00075 lesson).
- Any item that would raise an autonomy level updates
  `docs/governance.md` and `docs/ai-authority-matrix.md` in the same
  change, *before* the capability ships — governance first, code
  second, always.
- Verification claims in phase reports follow the house rule: built /
  merged / applied / deployed / verified live are reported as the
  distinct states they are, from persisted evidence, never from a
  summary of a summary.

*End of plan. Prepared 2026-11-07 from the owner's north star
(2026-11-07 voice call), the 2026-10-31 end-state and autonomy ladder,
repo state at `306e58eb`, `docs/governance.md`,
`docs/ai-authority-matrix.md`, `docs/eld-compliance-roadmap.md`, and
`docs/design/employer-pay-profile.md`. Nothing in this plan is built
by its existence.*

---

## 10. Decisions addendum — owner, 2026-11-07 voice call (after the plan landed)

Worked through one by one with the owner the same morning. These decisions
sharpen §8; where they differ from the questions as posed, the decision wins.

1. **Load boards are multiple, and agents are per driver.** The dispatcher
   does not read one board for one man. Each driver/employee gets his own
   agent (his Telegram partner), and that agent reads across **multiple**
   load boards and feeds that driver his options. Phase 1's learning source
   is unchanged: the loads arriving through Steven's company today, plus the
   owner's own experience dictated into the system — the app develops and is
   optimized continuously from that, over time, and it must be **functional
   when he is ready to start with his own truck**, not finished-perfect.
2. **Amazon Relay is later, and probably not solo.** The owner doubts he
   qualifies for Relay himself; his expectation is it would need a hired
   driver put on that account, or a signup attempted to see if they accept
   him. Relay is removed from any solo-phase assumption; it returns when
   there is a driver to put on it or an acceptance in hand.
3. **Business email: yes, under the existing LLC.** He will retrieve his
   LLC/EIN details and get a business email matching the trucking business
   name he has in mind. A DBA/fictitious name does not change the EIN, so
   the LLC's information can be used now. Company/owner-only pages in the
   app are established as accessible **only to him** (his personal ID),
   never to employees — that owner-only layer can start being built while
   he is still driving for Steven.
4. **Bonus pool: 10% to start.** Ten percent of verified dispatch savings
   funds the driver bonus pool as the starting rule, adjustable once real
   numbers exist. He wants the wider structure modeled on a box-truck
   operator he follows (named from memory as "Truck Bros / Truckin Bros,"
   a dreadhead creator on YouTube/Instagram who treats his employees
   well) — that structure must be researched and verified before any
   specifics are adopted; the name as recalled is not a citation.
5. **Abel machine learning / outcome log: GO-AHEAD, and start ordered.**
   The §6 proposal in `docs/design/bot-messages-and-safety.md` (outcome
   log → lessons from corrections → risk scoring) is approved, and the
   owner ordered the start on 2026-11-07. It remains a gated build like
   everything else — built, gated, merge and deploy on his taps; approval
   here is not a claim that it is live.
6. **Scoring posture — the agent asks (this corrects §8 question 3).**
   There is **no money-month switch** and no automatic re-ranking. Scoring
   runs on each driver's own preference, and when a load creates a
   trade-off, that driver's agent must **ask, smartly, before acting on
   it**: state the effect plainly — "this is going to affect this; you
   won't be able to get home at this time — do you want to do that or
   no?" — and wait for the driver's answer. The trade-off is surfaced,
   never silently absorbed into a score. §2.4's Gate 2 is amended
   accordingly: a lifestyle conflict converts the workup into a question
   to the driver, and the load is not ranked as a clean take until he
   answers.

The owner confirmed there were no other outstanding questions from §8 at
this time; the remaining §8 items (infrastructure ceiling, auto-send
appetite statement, ELD posture costing) stay open for a later pass and
do not block Phase 1.
