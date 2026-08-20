# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository status

This repository is pre-implementation. It currently contains only planning/vision documents — there is no `src/`, `docs/`, `tests/`, build tooling, package manifest, or application code yet:

- `README.md` — one-paragraph product pitch.
- `My idea` — a raw brainstorm/chat transcript describing the product vision in detail (not formatted as a spec).
- `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW` — the mandatory process this project must follow from idea through deployment.

There are no build, lint, or test commands to run because no codebase exists yet. Do not invent tooling, frameworks, or a directory layout on your own — the workflow document below is explicit that repository structure and architecture must be *designed* (and written down under `docs/`) before any code is written.

## What is being built

An "AI-Powered Transportation Operating System" for a trucking business — see `README.md` and `My idea` for full context. In short, three layers working together:

1. **The physical company** — trucks, trailers, drivers, fuel, maintenance, insurance, freight, customers, parking, cash.
2. **The business operating system** — a system of record for trucks, drivers, loads, revenue/expenses, brokers, lanes, compliance, etc.
3. **The AI operating layer** — analyzes the business state and recommends (not autonomously executes) decisions: which load to take, where to park, when to fuel, whether the fleet is ready to expand, etc.

`My idea` enumerates the envisioned subsystems in detail (decision engine, "Florida trap"/positioning risk engine, load profitability engine, fuel intelligence, load-board integration, home-time engine, parking network, maintenance AI, financial AI, fleet-expansion engine, driver management). Treat these as product-vision notes to be formalized into specs, not as an implementation backlog to start coding against directly.

A guiding principle repeated throughout `My idea`: **AI observes and recommends; it does not unilaterally control the business.** Automation is only introduced gradually, behind explicit approval and authority boundaries (see Phase 9/10 below).

## Mandatory development workflow

`MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW` is the governing process document for this repository and applies to any AI assistant or agent working here. Its master rule:

> **NO CODE IS WRITTEN UNTIL DESIGN IS COMPLETE.** Specify → Design → Govern → Contract → Structure → Implement → Test → Review → Deploy → Learn → Repeat.

Key implications for how to work in this repo right now:

- **Spec-first, phased pipeline.** The full sequence is: Problem Discovery → Vision & Scope → Requirements → User Stories/Workflows → Governance/Safety/Authority → Architecture → System Contracts → Detailed Design → Service Specs → Intelligence Design → Automation/Autonomy → Runtime → Repository Architecture → Roadmap → Tasks → Implementation → Testing → Review → Deployment → Postmortem. Each phase has a defined deliverable under `docs/` (e.g. `docs/idea.md`, `docs/vision.md`, `docs/requirements.md`, `docs/architecture.md`, `docs/api-contracts.md`, `docs/design/*.md`). None of these exist yet — creating them is the actual next step for this project, not writing application code.
- **If you're asked to add code before these docs exist**, treat it as a signal to first ask whether the missing spec/architecture step should be done, per "STOP → IDENTIFY THE PROBLEM → UPDATE THE SPECIFICATION → REVIEW THE DESIGN → THEN IMPLEMENT." Don't silently invent architecture inside the code.
- **Repository structure follows architecture, not imagination.** Don't pre-create `src/`, `services/`, `features/` etc. speculatively — the workflow doc's example trees (`project/docs,src,tests,scripts,...` and the `src/app,components,features,services,data,hooks,lib,types,config,state` layout) are illustrative patterns to select from once an architecture is actually approved, not a checklist to scaffold immediately.
- **AI authority boundaries (Phase 4/9/14 of the doc):** AI may analyze, classify, summarize, rank, predict, recommend, simulate, generate, and detect patterns. AI must never expand its own permissions, invent facts, override governance, modify protected systems, execute restricted actions, or bypass approval requirements. High-risk actions require human approval unless explicitly designed otherwise.
- **Engineering guardrails** once code exists: strict typing, small single-responsibility files/functions (~300 lines/file, ~50 lines/function as warning thresholds, not hard limits), no business logic embedded in UI, dedicated service boundaries for API/DB/AI calls, no hardcoded secrets (use `.env.example` to document required config), no dead code or "clean up later" shortcuts, contracts (API/data schemas) treated as source of truth that code must conform to.
- **Project state tracking:** `PROJECT_STATE.md` (current phase, sprint, completed/in-progress/blocked, next tasks, known issues, technical debt) is meant to be kept up to date whenever meaningful progress happens — create/update it once implementation begins.
- **Documentation and code must never knowingly contradict each other** — when architecture, requirements, or contracts change, the corresponding `docs/*.md` file must change with them.

When in doubt about scope, authority, or architecture, the workflow document's own rule applies: stop, check the specification, and ask rather than guess.
