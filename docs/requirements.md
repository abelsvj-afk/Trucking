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
- Fuel intelligence: cheapest *effective* fuel accounting for detour cost.
- Home-time engine: hard/soft scheduling constraints feeding into dispatch decisions.
- Freight intelligence / load-board integration through authorized sources.
- AI assistant / decision engine producing take/negotiate/decline recommendations with reasoning.
- Parking network, maintenance pattern detection, fleet-expansion readiness scoring, and driver compliance management (CDL/medical/clearinghouse) once there are employees.

## Non-Functional Requirements

- **Performance:** Must stay responsive for a single operator (and later, a small fleet's worth of records) doing everyday data entry and lookups. No high-concurrency or large-scale performance target exists at this stage — the system is not designed for many simultaneous users.
- **Security:** Must follow the guardrails already defined in `CLAUDE.md` ("Middleware, diagnostics & security guardrails") — no hardcoded secrets, authenticated/authorized access to data, least-privilege credentials, and no unvalidated external input treated as trusted.
- **Reliability:** Data entered by the operator must not be silently lost or corrupted; failures must be surfaced, not hidden (per the workflow doc's "silent failures are prohibited" rule).
- **Scalability:** Must comfortably scale from one truck to a small fleet (a handful of trucks/drivers). Scaling to a multi-tenant product for other operators is future scope (see `docs/vision.md` non-goals) and not a current requirement.
- **Availability:** No formal uptime target exists yet. Given the primary user is a working driver, the system should be usable from a phone or laptop without requiring specialized hardware.
- **Accessibility:** No specific accessibility standard has been chosen yet. This should be revisited once a UI is actually designed (Phase 7).
- **Observability:** Per `CLAUDE.md`, diagnostics (structured logging without secrets, health checks, and an audit trail for anything AI-recommended or AI-executed once that exists) are required once there's a runtime to observe.
- **Maintainability:** Must follow the engineering guardrails already set in `CLAUDE.md` — strict typing, small single-responsibility files/functions, no duplicated logic, contracts treated as source of truth.

## Constraints

- **Budget:** Not yet defined.
- **Hosting:** Not yet defined.
- **Hardware:** No specialized hardware is assumed; the primary user's access is expected to be a phone and/or laptop while working as a driver, but this hasn't been formally scoped.
- **Third-party services:** None selected yet. Any future selection (hosting, database, AI provider, fuel-price/load-board data source) must go through the Dependency Rule in `CLAUDE.md` — vetted, justified, and not adopted purely for convenience.
- **Licensing:** Not yet defined.
- **Platform restrictions:** None formally set. Given the primary user works from the road, a mobile-friendly interface is likely important, but this is a product consideration for later design phases, not a locked requirement yet.
- **Regulatory constraints:** The system will touch data adjacent to DOT/FMCSA compliance (per `README.md`) and driver personal information. Per `docs/vision.md`'s non-goals, this system is not intended to become the authoritative regulatory record (e.g. it does not replace an ELD/HOS system of record) — it tracks and surfaces compliance-relevant data, it doesn't certify it.
- **Data restrictions:** Financial data and driver PII must be handled per the security guardrails in `CLAUDE.md` — no PII or financial data in logs, least-privilege access, no secrets in the repository.

---

*Open items in this document (budget, hosting, third-party services, accessibility standard, availability target) are unresolved by design — they should be filled in with real decisions, not assumptions, before the phases that depend on them (Architecture, Runtime, Deployment) proceed.*
