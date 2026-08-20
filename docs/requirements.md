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
- **Industry intelligence / proactive research engine** (new scope, not in `My idea` — added directly by the owner): continuously monitors fuel market trends, regulatory/political developments affecting trucking, and longer-term industry disruption (e.g. autonomous trucking), surfacing relevant findings as a recommendation/briefing. Recommend-only, per `docs/governance.md`; external sources it reads are untrusted input, per `CLAUDE.md` — same treatment as load-board/broker data. Delivery mechanism (push vs. digest) and actual data sources are undecided, left to that capability's own future design phase.
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

- **Budget:** Free/near-free to start, per the decision in `docs/architecture.md` — free-tier hosting/database (Vercel + Supabase), scaling to paid tiers only once real usage or revenue justifies it.
- **Hosting:** Vercel (app) + Supabase (database/auth/storage), decided in `docs/architecture.md`.
- **Hardware:** No specialized hardware is assumed; the primary user's access is expected to be a phone and/or laptop while working as a driver. The system is designed mobile-first (`docs/design/ui-ux.md`), with a native app-store version planned for later (`docs/architecture.md`'s "Mobile and app-store path").
- **Third-party services:** Supabase (database, auth, file storage) per `docs/architecture.md`. Any further selection (AI provider, fuel-price/load-board data source) must go through the Dependency Rule in `CLAUDE.md` — vetted, justified, and not adopted purely for convenience.
- **Licensing:** Not yet defined.
- **Platform restrictions:** Mobile-first responsive web app (installable/PWA), per `docs/design/ui-ux.md`, with a native App Store/Play Store version planned once the system is proven (`docs/architecture.md`).
- **Regulatory constraints:** The system will touch data adjacent to DOT/FMCSA compliance (per `README.md`) and driver personal information. Per `docs/vision.md`'s non-goals, this system is not intended to become the authoritative regulatory record (e.g. it does not replace an ELD/HOS system of record) — it tracks and surfaces compliance-relevant data, it doesn't certify it.
- **Data restrictions:** Financial data and driver PII must be handled per the security guardrails in `CLAUDE.md` — no PII or financial data in logs, least-privilege access, no secrets in the repository.

---

*Budget, hosting, third-party services (Phase 5), platform, and accessibility (Phase 7) were resolved as later phases produced real decisions — see the cross-references above. Still open: a formal availability/uptime target and licensing, which stay unresolved by design until a real decision, not an assumption, is made.*
