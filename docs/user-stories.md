# User Stories & Workflows

Phase 3 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`, describing how humans and external actors interact with the system defined in `docs/requirements.md`. This describes interaction, not implementation — UI, data model, and API design belong to later phases.

## User Stories

### Primary user: Owner-Operator (founder)

- As the owner-operator, I want to record my trucks, trailers, and drivers in one place, so that I don't have to track them across separate notes and spreadsheets.
- As the owner-operator, I want to log each load (origin, destination, rate, miles, dates, broker/customer) so that I have a complete, searchable history of freight I've hauled.
- As the owner-operator, I want to record fuel purchases (location, gallons, price, date) so that I can see fuel costs over time.
- As the owner-operator, I want to log maintenance events and costs per truck, so that I can see a truck's full maintenance history in one place.
- As the owner-operator, I want to track expenses (insurance, permits, repairs, etc.) so that I understand where the business's money is going.
- As the owner-operator, I want to store broker and customer contact and relationship information, so that I don't lose track of who I've worked with.
- As the owner-operator, I want to attach documents (bills of lading, settlement statements, permits) to the relevant truck, load, or driver record, so that records are available when I need them.
- As the owner-operator, I want a basic financial summary (revenue vs. expenses), so that I can see whether the business is profitable even before a dedicated financial engine exists.

### Administrator

During the MVP, the administrator is the same person as the owner-operator. This becomes a distinct role once the system has more than one user (e.g. additional drivers, a future co-owner).

- As the administrator, I want to control who can view or edit company data, so that sensitive financial and driver information isn't exposed to people who shouldn't see it.

### AI agent / system (future, post-MVP)

- As the AI layer, I want to analyze logged load, fuel, and maintenance data, so that I can recommend the more profitable choice — always as a recommendation the owner-operator approves, never as an automatic action, per the non-goals in `docs/vision.md`.
- As the AI layer, I want to flag data that looks incomplete or inconsistent (e.g. a load missing a rate), so that the human corrects it rather than the system silently guessing or filling gaps with invented numbers.

### External systems (future)

- As a fuel-price data source, I want to feed price data into the system through an authorized integration, so that a future fuel-intelligence capability can use accurate, current prices instead of manual lookups.
- As a load-board or broker integration, I want to feed available freight into the system through an authorized API or partner feed, so that load data doesn't depend on manual entry or unauthorized scraping (per the non-goals in `docs/vision.md`).

### Operators (future — additional drivers as the fleet grows)

- As a driver who is not the owner, I want to log my own loads, fuel stops, and home-time preferences, so that the business has accurate operational data without the owner having to enter everything by hand.

### Failure scenarios

- As the owner-operator, if I enter a load with missing or invalid data (e.g. no rate, no mileage), I want the system to reject or flag it rather than silently accepting an incomplete record, so that later profitability numbers aren't built on bad data.
- As the owner-operator, if a future third-party data feed (fuel prices, load board) becomes unavailable, I want the system to tell me it's stale or unavailable rather than silently showing outdated numbers as current.
- As the owner-operator, if the AI layer can't make a confident recommendation (e.g. missing cost data for a load), I want it to say so explicitly rather than guessing or inventing numbers, per the "AI must not invent unavailable data" rule in `CLAUDE.md`.

## Workflows

### Normal workflow — recording a load

1. Owner-operator enters load details: origin, destination, rate, miles, pickup/delivery dates, and broker/customer.
2. System stores the load against the relevant truck and driver.
3. The load appears in that truck's and driver's history and in the financial summary.

### Alternative workflow — recording a load with incomplete information

1. Owner-operator enters partial load details (e.g. rate not yet confirmed with the broker).
2. System stores it as a draft/incomplete record rather than a finalized one.
3. Owner-operator completes it later, before it's included in any profitability calculation.

### Error workflow — invalid data entry

1. Owner-operator attempts to save a record with a missing required field or an invalid value.
2. System rejects the save and explains what's wrong, rather than silently accepting or "fixing" it.
3. Owner-operator corrects the input and resubmits.

### Approval workflow — AI-recommended action (future, post-MVP)

1. AI layer analyzes available data and proposes a recommendation (e.g. "take this load," "buy fuel here").
2. The recommendation is presented to the owner-operator along with its reasoning.
3. The owner-operator approves, modifies, or rejects it. The system takes no action until approved — this is the workflow-level enforcement of the "AI observes and recommends; it does not unilaterally control the business" principle in `docs/vision.md`.

### Escalation workflow — ambiguous or high-stakes situations

1. The AI layer or system encounters something it can't resolve confidently — conflicting data, or a decision with significant financial impact.
2. The system surfaces this to the owner-operator explicitly rather than proceeding on a best guess.
3. The owner-operator makes the call, and the resolution is recorded for future reference.

### Recovery workflow — data or integration failure

1. A data source (manual entry today; a future integration later) fails to save or sync.
2. The system surfaces the failure rather than silently dropping data, per the "silent failures are prohibited" rule already established in `CLAUDE.md`.
3. The owner-operator or system retries once the underlying issue is resolved. No data is fabricated to fill the gap in the meantime.

---

*This document defines interaction and workflow only. Governance and authority boundaries (who/what may read, write, recommend, approve, execute) belong to `docs/governance.md`, the next phase.*
