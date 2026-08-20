# Problem Discovery

Phase 0 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. This phase is about the underlying human/business problem only — no architecture, no tool selection, no AI-solution assumptions, and no automation promises. Source material: `README.md` and `My idea`.

## Who is this for?

Primarily one person today: the founder, who is starting as a company driver (Western Express) with the intent to become an owner-operator and eventually run a small fleet. In the long run, if the internal tool proves valuable, it could serve other owner-operators and small fleet operators facing the same problems — but that is a possible future audience, not who this is being built for right now.

## What problem are we solving?

Building and scaling a trucking business — from first driving job, to owner-operator, to a multi-truck fleet — requires tracking and coordinating many interdependent, constantly changing variables: trucks, drivers, loads, fuel, maintenance, compliance, and cash flow. Today that information lives scattered across memory, paper, spreadsheets, broker portals, load boards, and settlement statements, with no single place that shows the real operational and financial picture or helps turn it into a decision.

## Why does the problem matter?

Trucking runs on thin margins and is highly sensitive to operating decisions — deadhead miles, fuel routing, load selection, and positioning all directly move the bottom line, and mistakes compound. A load that looks good at the headline rate can be a net loss once deadhead, fuel, and repositioning are accounted for; a missed maintenance pattern becomes an expensive breakdown; poor positioning can strand a truck in a freight-dead region. Without centralized, accurate data, decisions get made on incomplete information — and in the early stage of one truck or a small fleet, there's little margin to absorb costly mistakes.

## What hurts the most?

Based on the founder's own account in `My idea`:

- Not knowing whether a load is actually profitable once deadhead, fuel, and repositioning cost are factored in — a rate per mile alone is misleading.
- Getting stuck in freight-dead regions (the "Florida trap" pattern) after taking a load that looked fine in isolation.
- Balancing home-time commitments against profitable positioning, without a way to weigh the tradeoff numerically.
- Not having visibility into maintenance history/patterns before they turn into breakdowns.
- Having none of this — trucks, loads, fuel, maintenance, cash — in one place to reason about, while still learning the business from the inside as a driver.

## What happens if nothing is built?

The business still gets built, but decisions get made from memory, spreadsheets, and gut feel — the way most small operators run today. Costly mistakes (bad loads, poor positioning, missed maintenance, deadhead waste) get diagnosed after the fact instead of prevented, and growth decisions (e.g. adding a second truck) get made on a feeling of "we're doing okay" rather than a real financial-readiness picture.

## What existing solutions exist?

General categories of existing tooling are known to exist — ELD/compliance platforms, TMS (transportation management) software, and load boards — but no structured competitive review has been done as part of this project yet. **This section is a placeholder and should be filled in with real research** (what those tools actually cover, where they fall short for a solo operator scaling from one truck, and what, if anything, already solves this problem well enough) before it's treated as settled.

## What does success look like?

The founder is running a profitable, growing trucking operation — first truck, through owner-operator, toward a small fleet — making decisions grounded in real cost and profit data instead of guesswork, with fleet, financial, freight, fuel, maintenance, compliance, and driver information centralized in one place instead of scattered across memory, paper, and spreadsheets.

## What is the simplest useful solution?

A single company database that centralizes the data currently scattered across notes and spreadsheets: trucks, trailers, drivers, loads, expenses, fuel, maintenance, customers, brokers, and documents. No AI, no automation — just one source of truth to replace scattered tracking while the founder is still a company driver gathering real-world requirements for everything that gets built on top of it later.

---

*This document defines the problem only. It does not define the product, the architecture, or the AI capabilities that solve it — those belong in `docs/vision.md` and later phases.*
