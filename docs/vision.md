# Vision & Scope Lock

Phase 1 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`, built on the problem defined in `docs/idea.md`. This phase defines what the system is, and just as importantly what it is not — no implementation, no architecture, no uncontrolled feature expansion, and no automation promises. Source material: `README.md` and `My idea`.

## Mission

Give an independent trucking operator — starting from one truck and scaling toward a small fleet — a single source of truth and decision-support system for running the business profitably: centralizing fleet, financial, freight, fuel, maintenance, compliance, and driver data, and using AI to recommend sound operating decisions rather than replace the operator's judgment.

## Vision statement

A transportation company where trucks generate the cash flow, software coordinates the operation, and AI continuously improves the business. The trucks are the physical asset; the operating system is the single source of truth; the AI layer analyzes the business and recommends action — but the human stays in control of every consequential decision. ("Build the machine. The money follows." — `README.md`)

## Target users

- **Primary, now:** the founder, as an owner-operator scaling from a single truck.
- **Future, not current scope:** other owner-operators and small fleet operators facing the same problems, if the system proves valuable enough to become a standalone product (`My idea`, section 17). Building for external customers is explicitly future scope — see Non-Goals below.

## Core value proposition

Turns scattered, memory- and spreadsheet-based trucking operations into a centralized, data-grounded system that shows *true* load, route, and truck profitability — not just headline rate-per-mile — and recommends decisions instead of leaving the operator to guess.

## MVP definition

Per the version roadmap in `My idea` (section 16), the MVP is **v0.1 — Company Database**: a system of record covering trucks, trailers, drivers, loads, expenses, fuel, maintenance, customers, brokers, and documents. No AI and no automation at this stage — its purpose is to consolidate the data that every later capability (financial engine, load profitability, positioning, fuel intelligence, AI assistant) will need to reason over.

## Success criteria

The founder can look at one system and answer, with real numbers, questions like: is Truck #1 profitable, what is the current cash position, what maintenance is coming due, and what is compliance status — without cross-referencing spreadsheets, paper, or memory.

## Success metrics

Not yet defined. Concrete, measurable targets (e.g. a target operating margin, a reduction in time spent reconciling records, load-acceptance decisions grounded in true-profit calculations vs. rate-per-mile alone) should be set once the MVP is in real use and there is operating data to baseline against — they are not invented here.

## Explicit non-goals

Scope this project is *not* pursuing right now:

- **No autonomous execution.** The system observes and recommends; it does not book loads, send emails, or move money on its own. (`My idea`'s automation levels 1–6 place autonomous action, even for narrow workflows under strict limits, well past the current stage — see the Automation & Autonomy phase in the workflow doc before any of that is designed.)
- **No aggressive scraping of load boards or third-party sites.** Any freight-data ingestion should go through authorized integrations (APIs, partner feeds), not unauthorized scraping.
- **Not a multi-tenant product for other operators.** Serving other owner-operators is an explicit *future* possibility (see Target Users), not something the MVP or near-term roadmap builds toward.
- **Not a replacement for systems of record required by regulation** (e.g. ELD/HOS compliance systems) — this system may track and surface compliance data but does not aim to become the authoritative regulatory record.
- **No AI-invented data.** Recommendations are only as good as the underlying data; the system must not fabricate figures (rates, costs, maintenance history) it doesn't actually have.

## Future features

Beyond the v0.1 MVP, the roadmap sketched in `My idea` (section 16) — to be formalized into real requirements/architecture before being built, not implemented directly from this list — points toward:

- Financial engine (weekly revenue/expense/profit tracking, operating margin)
- Truck cost engine (true cost per mile per truck)
- Load profitability engine (true revenue/profit per truck mile, accounting for deadhead, fuel, tolls, maintenance reserve, insurance, parking)
- Route/positioning engine, including geographic risk scoring for freight-dead regions (the "Florida trap" pattern)
- Fuel intelligence (cheapest *effective* fuel accounting for detour cost, not just sticker price) — needs a real-time fuel-price data source, through an authorized integration (see the non-goal against scraping)
- Home-time engine (hard/soft constraints tying dispatch decisions to personal schedule)
- Freight intelligence / load-board integration (through authorized sources, feeding a decision engine)
- AI assistant / decision engine tying the above together into "take this load / don't" style recommendations. Per `My idea` section 1, its actual inputs include available loads, fuel prices, deadhead, **hours-of-service (HOS) limits**, delivery deadlines, maintenance status, home time, parking, expected revenue, operating cost, **weather**, **road restrictions**, and driver preferences — named explicitly here so they don't get quietly dropped when this is formalized into a real spec.
- **Email AI / automated outreach and freight research** (`My idea` section 7, and explicitly listed in `README.md`'s core capabilities): AI drafts outreach to brokers/shippers about capacity on a lane; a human approves and sends at first, with more autonomy (auto-send within predefined rules, then AI-assisted negotiation within hard limits) only introduced later through the graduated-autonomy process in `docs/governance.md` — never by default.
- Parking network, maintenance pattern detection ("digital twin" per truck), fleet-expansion readiness scoring, and driver management (CDL/medical/compliance tracking) once there are employees
- Eventually, productizing the system for other owner-operators (explicitly out of scope until the internal version is proven)

---

*This document defines what the system is and is not. It does not define requirements, architecture, or implementation — those belong to later phases (`docs/requirements.md`, `docs/architecture.md`, etc.) per the workflow doc.*
