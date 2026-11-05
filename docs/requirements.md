# Requirements

Phase 2 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`, translating `docs/vision.md` into precise system requirements. This defines *what* the system must do, not *how* — architecture, data model, and API design belong to later phases (`docs/architecture.md`, `docs/api-contracts.md`, `docs/schemas.md`).

## Functional Requirements

### MVP (v0.1 — Company Database, per `docs/vision.md`)

The system must let the owner-operator record and retrieve:

- **Trucks** — identifying details (e.g. VIN, unit number), mileage, and status.
- **Trailers** — identifying details and status.
- **Drivers** — identifying details, and which truck they're currently assigned to.
- **Loads** — origin, destination, pickup/delivery dates, rate, mileage, broker/customer, and which truck/driver hauled it.
- **Expenses** — category, amount, date, and which truck/load/driver they're attributed to where applicable.
- **Fuel purchases** — location, gallons, price, date, and which truck.
- **Maintenance events** — description, cost, date, mileage at time of service, and which truck.
- **Customers and brokers** — contact and relationship information.
- **Documents** — files (e.g. bills of lading, settlement statements, permits) attached to the relevant truck, load, or driver record.

The system must also let the owner-operator see a basic financial summary (revenue vs. expenses) derived from the above records, without requiring a dedicated financial engine to exist yet.

### Future phases (not required for the current implementation)

These follow the roadmap in `docs/vision.md` / `My idea` and each requires its own requirements/architecture pass before being built — listed here only so later work has a fixed reference point, not as authorization to build ahead of the workflow:

- Financial engine: recurring revenue/expense/profit and operating-margin reporting.
- Truck cost engine: true cost per mile per truck.
- Load profitability engine: true profit per truck mile accounting for deadhead, fuel, tolls, maintenance reserve, insurance, and parking.
- Route/positioning engine, including geographic risk scoring for freight-dead regions.
- Fuel intelligence: cheapest *effective* fuel accounting for detour cost. Requires a real-time fuel-price data source through an authorized integration — not a stored/static price. Its screen must show the optimized route visually on a map, not just as a number — an explicit UI requirement for whenever this capability gets its own Phase 2/7 pass.
- Home-time engine: hard/soft scheduling constraints feeding into dispatch decisions.
- Freight intelligence / load-board integration through authorized sources.
- AI assistant / decision engine producing take/negotiate/decline recommendations with reasoning, drawing on loads, fuel prices, deadhead, HOS limits, delivery deadlines, maintenance status, home time, parking, expected revenue, operating cost, **weather**, and **road restrictions** (per `My idea` section 1) — each of those inputs is its own future data source/integration, not something this system generates itself.
- **Email AI / automated outreach and freight research**, per `README.md`'s core capabilities and `My idea` section 7: drafting broker/shipper outreach, always human-approved before sending until graduated autonomy (`docs/governance.md`) explicitly authorizes more.
- **Industry intelligence / proactive research engine** (new scope, not in `My idea` — added directly by the owner): monitors fuel market trends, regulatory/political developments affecting trucking, and longer-term industry disruption (e.g. autonomous trucking), surfacing relevant findings as a recommendation/briefing — never a raw feed. Runs autonomously on a schedule (Governance Level 5 — bounded autonomous execution, since scheduled unattended operation is itself an autonomous action), with its own dedicated on/off switch per `docs/governance.md`'s per-capability revocation rule. The schedule may adapt to how active the trucking landscape is, but only within an owner-set minimum/maximum interval — unbounded self-adjustment of its own operating frequency would violate the "AI must never silently expand its own authority" rule. External sources it reads are untrusted input, per `CLAUDE.md`. Delivery mechanism, sources, and default schedule are undecided, left to that capability's own future design phase.
- Parking network, maintenance pattern detection, fleet-expansion readiness scoring, and driver compliance management (CDL/medical/clearinghouse) once there are employees.

### User interface (applies from the MVP onward — non-negotiable)

This project has previously been built with a workflow that produced backend only — no working frontend, nothing the owner-operator could actually open and use. That outcome is explicitly unacceptable here and this requirement exists to rule it out, not to prescribe a specific look:

- **Every functional requirement above that a human interacts with must ship with a working, usable interface for it — not an API/backend the owner-operator can't actually reach.** A feature that only exists as a backend endpoint or database table is incomplete, full stop, regardless of how well-architected the backend is.
- The system must be presented through a real, navigable interface (dashboard-style, with clear sections/navigation for trucks, loads, expenses, fuel, maintenance, documents, and the financial summary) rather than one undifferentiated view or no view at all. The specific visual design, layout, and navigation structure are not dictated here — that's a design decision to be made well at the appropriate phase (Phase 7, `docs/design/ui-ux.md`, after architecture and contracts are settled), using good UI/UX judgment for someone using this primarily from a phone while driving. What's fixed is the outcome: it must actually exist and be genuinely usable, not that it must look a particular way.
- From the point any AI recommendation or automation capability exists (Graduated Autonomy Level 2+, per `docs/governance.md`), the interface must visibly surface the AI's current authorization state and the revocation controls `docs/governance.md` requires — a global stop and, once Level 5/6 capabilities exist, per-capability stops — placed prominently, not buried in nested settings.
- **Implementation-phase check:** no task in Phase 15 (Implementation) that adds or changes user-facing functionality is considered done when only its backend is built. If a task's acceptance criteria don't already include a working frontend for that functionality, that's a defect in the task breakdown (Phase 14) to fix before implementing, not something to implement around.

## Non-Functional Requirements

- **Performance:** Must stay responsive for a single operator (and later, a small fleet's worth of records) doing everyday data entry and lookups. No high-concurrency or large-scale performance target exists at this stage — the system is not designed for many simultaneous users.
- **Security:** Must follow the guardrails already defined in `CLAUDE.md` ("Middleware, diagnostics & security guardrails") — no hardcoded secrets, authenticated/authorized access to data, least-privilege credentials, and no unvalidated external input treated as trusted.
- **Reliability:** Data entered by the operator must not be silently lost or corrupted; failures must be surfaced, not hidden (per the workflow doc's "silent failures are prohibited" rule).
- **Scalability:** Must comfortably scale from one truck to a small fleet (a handful of trucks/drivers). Scaling to a multi-tenant product for other operators is future scope (see `docs/vision.md` non-goals) and not a current requirement.
- **Availability:** No formal uptime target exists yet. Given the primary user is a working driver, the system should be usable from a phone or laptop without requiring specialized hardware.
- **Accessibility:** WCAG 2.1 AA, decided in `docs/design/ui-ux.md` (Phase 7).
- **Observability:** Per `CLAUDE.md`, diagnostics (structured logging without secrets, health checks, and an audit trail for anything AI-recommended or AI-executed once that exists) are required once there's a runtime to observe.
- **Maintainability:** Must follow the engineering guardrails already set in `CLAUDE.md` — strict typing, small single-responsibility files/functions, no duplicated logic, contracts treated as source of truth.

## Constraints

- **Budget:** Free/near-free to start, per the decision in `docs/architecture.md` — free-tier hosting/database (Fly.io + Supabase), scaling to paid tiers only once real usage or revenue justifies it.
- **Hosting:** Fly.io (app, Docker) + Supabase (database/auth/storage) — changed from an original Vercel decision when the owner chose Fly.io directly during Stage 3; see `docs/architecture.md`.
- **Hardware:** No specialized hardware is assumed; the primary user's access is expected to be a phone and/or laptop while working as a driver. The system is designed mobile-first (`docs/design/ui-ux.md`), with a native app-store version planned for later (`docs/architecture.md`'s "Mobile and app-store path").
- **Third-party services:** Supabase (database, auth, file storage) per `docs/architecture.md`. Any further selection (AI provider, fuel-price/load-board data source) must go through the Dependency Rule in `CLAUDE.md` — vetted, justified, and not adopted purely for convenience.
- **Licensing:** Not yet defined.
- **Platform restrictions:** Mobile-first responsive web app (installable/PWA), per `docs/design/ui-ux.md`, with a native App Store/Play Store version planned once the system is proven (`docs/architecture.md`).
- **Regulatory constraints:** The system will touch data adjacent to DOT/FMCSA compliance (per `README.md`) and driver personal information. Per `docs/vision.md`'s non-goals, this system is not intended to become the authoritative regulatory record (e.g. it does not replace an ELD/HOS system of record) — it tracks and surfaces compliance-relevant data, it doesn't certify it.
- **Data restrictions:** Financial data and driver PII must be handled per the security guardrails in `CLAUDE.md` — no PII or financial data in logs, least-privilege access, no secrets in the repository.

---

*Budget, hosting, third-party services (Phase 5), platform, and accessibility (Phase 7) were resolved as later phases produced real decisions — see the cross-references above. Still open: a formal availability/uptime target and licensing, which stay unresolved by design until a real decision, not an assumption, is made.*

---

## Current capability catalogue — 2026-11-05 (RECONCILIATION DRAFT, pending owner review)

The sections above remain the original requirements. This catalogue lists what is **built** so every capability has an ID, a safety class and a link to its owning design. "Moving" classes follow the driving-safety rule: unknown or stale speed counts as possibly moving.

Safety class: **M** = usable while moving (glance/voice only) · **P** = parked only · **V** = voice/Telegram acceptable · **S** = server/unattended (no screen).

| ID | Capability | Owning design / doc | Safety | Status |
|---|---|---|---|---|
| REQ-01 | Loads, trips, stops (any number), trip tasks, per-stop arrival/approval taps | `docs/design/trip-intake.md` | P | built |
| REQ-02 | Dispatch message → load: code-read structured trips, model path for other formats, one review + one yes | trip-intake | V | built (Relay parser pending real messages) |
| REQ-03 | Confirmation lifecycle: last-shown targeting, retained failures, silent expiry, cancel ≠ delete | trip-intake, `docs/ai-authority-matrix.md` §5 | V | built |
| REQ-04 | Hours: carrier-anchored cycle, live clocks, paper-log helper; **not an ELD** | `docs/time-and-hos.md`, `driver-hud.md` | M (read), P (edit) | built |
| REQ-05 | Paper-log photo → review → atomic save; day graph; Telegram approval rule | `driver-hud.md` §6 | P/V | built (owner acceptance pending) |
| REQ-06 | Home HUD with live clocks and act-in-place popups | `driver-hud.md`, `driver-usability.md` | M | built |
| REQ-07 | Live layer: screens current without refresh | `driver-hud.md` §4 | S | built |
| REQ-08 | Driving safety lock: app-wide form lock when moving/unknown; Drive glance only | `driver-usability.md` §4 | M | built |
| REQ-09 | Smart Path route check + Drive Mode (spoken turns, rerouting only to truck-checked routes) | `docs/design/driver-mvp.md` §8 | M | built |
| REQ-10 | Screen-off position via Telegram Live Location; duty-status proposals only | `driver-usability.md` §4 | S/V | built (no switch — G1) |
| REQ-11 | Money truth: integer cents, revenue on delivery, month bounds in viewer zone | `docs/money-and-revenue.md` | P | built |
| REQ-12 | Pay terms per employer as data; pay advisor; settlements; weekly pay report | `docs/design/employer-pay-profile.md` | P/V | built (migration 00063 unapplied) |
| REQ-13 | Assistant (Abel): tools, memory, summaries, kill switches | `docs/ai-authority-matrix.md`, `ai-architecture.md` | V | built |
| REQ-14 | Photo / voice / document intelligence | `driver-mvp.md` §10, image-intelligence docs | V | built |
| REQ-15 | Research engine: watchers, signals, briefings, news banner (images server-fetched) | `research-engine.md`, `news-banner-images.md` | S/M | built (FMCSA feed unresolved) |
| REQ-16 | Game Plan | `gaming-system.md` | P | built |
| REQ-17 | Maintenance schedules, defects, watcher | maintenance docs | P/S | built |
| REQ-18 | Records lifecycle (soft delete, restore, retention) | `docs/record-lifecycle.md` | P | built |
| REQ-20 | Proactive logging reminders (HOS clocks 30/10/0 min, stale status) | `design/logging-reminders.md` | S | built, off until switched on |
| REQ-19 | Tenant isolation (RLS) and service-role exceptions | `docs/design/security.md` | S | built; **proof pending** (Wave 4) |

**Testable system-wide safety requirements** (to be turned into acceptance tests in Wave 4): SAF-1 no editable control is reachable while the vehicle is moving and permission is granted — forms AND editable controls outside forms (extended 2026-11-05 after an audit scan found the paper-log segment editor, day-edit panel, memory editing and photo pickers were not wrapped in forms); the lock is duty-aware: a slow-moving truck with a logged non-driving status gets a switch-to-Driving prompt instead of a hard lock (road speed or unknown speed still locks); the AI kill switches are a deliberate exception (turning authority off must always work) — owner may overrule; SAF-2 Drive's moving surface exposes only Skip stop, I'm parked, Talk to Abel, Voice toggle, Re-plan; SAF-3 a car-profile route can never replace a truck route; SAF-4 no proposal executes unless the owner just saw it.

**Open items carried from the original:** license choice; availability target; performance budgets for a phone with maps/live location/image proxying (propose: first meaningful paint < 3 s on 4G; Drive map update < 1 s per fix) — all **owner decisions**.
