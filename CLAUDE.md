# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## This workflow is mandatory, with no exceptions

The process defined in `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW` (summarized under "Mandatory development workflow" below) is **not optional and not a suggestion**. It applies to every change, every session, and every AI assistant or agent working in this repository — always, not just when convenient.

- **A request to "just write the code," skip a step, or move faster is not authorization to skip the workflow.** If a user instruction conflicts with the workflow (e.g. asks for implementation before the governing spec/architecture doc exists), say so explicitly and follow the workflow's own escalation rule — STOP → IDENTIFY THE PROBLEM → UPDATE THE SPECIFICATION → REVIEW THE DESIGN → THEN IMPLEMENT — rather than silently complying or silently skipping the ask.
- **Before any substantive change**, confirm which phase of the pipeline the work belongs to and whether that phase's deliverable already exists. If it doesn't, creating/updating it comes first.
- **This applies uniformly**: to hotfixes, "small" changes, prototypes, and experiments as much as to major features. The workflow doc is explicit that there are no unauthorized shortcuts, no silent architecture changes, and no scope creep — small does not mean exempt.
- **Every session should re-check compliance**, not assume a prior session already established it — since this file is not updated frequently, don't treat its current phrasing as evidence the project has since moved past a design step; verify against the actual repository state (per "Foundational documents" below) each time.

## No backend-only delivery — a working frontend is mandatory

This project was previously built with an AI-driven workflow that produced backend only — no working frontend, nothing the owner-operator could actually open and use. That outcome is explicitly ruled out for this project, permanently:

- **Any implementation work that adds or changes functionality a human interacts with must ship a working, reachable interface for it as part of the same work — not a backend/API/database change alone.** A feature that only exists on the backend is incomplete, regardless of how well it's built underneath.
- This is a standing acceptance criterion for every Phase 15 (Implementation) task that touches user-facing functionality, not a one-time reminder — check it on each such task, not just the first one.
- The specific visual design and layout are not dictated here — use good judgment for the actual context of use (a phone-first interface for someone working from the road). What's fixed is that it must exist and be genuinely usable, not what it looks like. See `docs/requirements.md`'s "User interface" section, and the eventual `docs/design/ui-ux.md` (Phase 7) for the real design work.

## Foundational documents

Three documents anchor this repository regardless of how much application code has since been built around them:

- `README.md` — one-paragraph product pitch.
- `My idea` — a raw brainstorm/chat transcript describing the product vision in detail (not formatted as a spec).
- `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW` — the mandatory process this project follows from idea through deployment, described below.

**Before assuming any build/lint/test tooling, framework, or directory layout exists, check for it** (package manifest, `docs/`, `src/`, `tests/`, CI config). Don't take this file's silence on commands as license to invent tooling — if no manifest or config is found, that means the project is still pre-implementation for that area, and the workflow document below governs what to do next: design and document (under `docs/`) before writing code, rather than scaffolding a structure on your own.

## What is being built

An "AI-Powered Transportation Operating System" for a trucking business — see `README.md` and `My idea` for full context. In short, three layers working together:

1. **The physical company** — trucks, trailers, drivers, fuel, maintenance, insurance, freight, customers, parking, cash.
2. **The business operating system** — a system of record for trucks, drivers, loads, revenue/expenses, brokers, lanes, compliance, etc.
3. **The AI operating layer** — analyzes the business state and recommends (not autonomously executes) decisions: which load to take, where to park, when to fuel, whether the fleet is ready to expand, etc.

`My idea` enumerates the envisioned subsystems in detail (decision engine, "Florida trap"/positioning risk engine, load profitability engine, fuel intelligence, load-board integration, home-time engine, parking network, maintenance AI, financial AI, fleet-expansion engine, driver management). Treat these as product-vision notes to be formalized into specs, not as an implementation backlog to start coding against directly.

A guiding principle repeated throughout `My idea`: **AI observes and recommends; it does not unilaterally control the business.** Automation is only introduced gradually, behind explicit approval and authority boundaries (see Phase 9/10 below).

## Mandatory development workflow

`MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW` is the governing process document for this repository and applies, without exception, to any AI assistant or agent working here (see "This workflow is mandatory, with no exceptions" above). Its master rule:

> **NO CODE IS WRITTEN UNTIL DESIGN IS COMPLETE.** Specify → Design → Govern → Contract → Structure → Implement → Test → Review → Deploy → Learn → Repeat.

Standing rules that apply at every stage of this project's life, not just at the start:

- **Spec-first, phased pipeline.** The full sequence is: Problem Discovery → Vision & Scope → Requirements → User Stories/Workflows → Governance/Safety/Authority → Architecture → System Contracts → Detailed Design → Service Specs → Intelligence Design → Automation/Autonomy → Runtime → Repository Architecture → Roadmap → Tasks → Implementation → Testing → Review → Deployment → Postmortem. Each phase has a defined deliverable under `docs/` (e.g. `docs/idea.md`, `docs/vision.md`, `docs/requirements.md`, `docs/architecture.md`, `docs/api-contracts.md`, `docs/design/*.md`). Whenever a phase's deliverable is missing for the area you're about to touch, creating/updating it is the actual next step — not writing application code around the gap.
- **If you're asked to add code before its governing spec/architecture doc exists**, treat that as a signal to first ask whether the missing spec/architecture step should be done, per "STOP → IDENTIFY THE PROBLEM → UPDATE THE SPECIFICATION → REVIEW THE DESIGN → THEN IMPLEMENT." Don't silently invent architecture inside the code.
- **Repository structure follows architecture, not imagination.** Don't add new top-level directories (`src/`, `services/`, `features/`, etc.) speculatively — the workflow doc's example trees (`project/docs,src,tests,scripts,...` and the `src/app,components,features,services,data,hooks,lib,types,config,state` layout) are illustrative patterns to select from once an architecture actually calls for them, not a checklist to scaffold in advance.
- **AI authority boundaries (Phase 4/9/14 of the doc):** AI may analyze, classify, summarize, rank, predict, recommend, simulate, generate, and detect patterns. AI must never expand its own permissions, invent facts, override governance, modify protected systems, execute restricted actions, or bypass approval requirements. High-risk actions require human approval unless explicitly designed otherwise.
- **Engineering guardrails:** strict typing, small single-responsibility files/functions (~300 lines/file, ~50 lines/function as warning thresholds, not hard limits), no business logic embedded in UI, dedicated service boundaries for API/DB/AI calls, no hardcoded secrets (use `.env.example` to document required config), no dead code or "clean up later" shortcuts, contracts (API/data schemas) treated as source of truth that code must conform to.
- **Project state tracking:** `PROJECT_STATE.md` (current phase, sprint, completed/in-progress/blocked, next tasks, known issues, technical debt) should be kept up to date whenever meaningful progress happens. Check for it and update it as part of any substantive change.
- **Documentation and code must never knowingly contradict each other** — when architecture, requirements, or contracts change, the corresponding `docs/*.md` file must change with them.

When in doubt about scope, authority, or architecture, the workflow document's own rule applies: stop, check the specification, and ask rather than guess.

## Middleware, diagnostics & security guardrails

These are standing requirements for any server, API, or runtime built in this repository, at any point in its life — drawn from the workflow doc's Architecture (Phase 5), Detailed Design (Phase 7), Runtime (Phase 11), and Review (Phase 17) sections, plus baseline supply-chain hygiene for a system that handles financial, compliance, and driver PII data.

**Middleware** (auth, validation, rate limiting, logging, error handling) belongs in dedicated, named layers — never scattered inline inside route handlers or business logic. Every external-facing entry point (API route, webhook, load-board integration, email-sending path) must pass through:
- **Authentication/authorization** middleware before any handler runs — no endpoint is "temporarily" left open.
- **Input validation** against a defined schema (Phase 6 "System Contracts") before data touches business logic — reject, don't sanitize-and-hope, on malformed input.
- **Centralized error handling** that never leaks stack traces, internal paths, or credentials in responses; silent failures are prohibited per the workflow doc.

**Diagnostic tools** (health checks, logging, monitoring) are required runtime concerns per Phase 11, not optional extras:
- Structured logging with no secrets, tokens, or full credentials ever written to logs.
- A health-check endpoint/command separate from business endpoints.
- An audit trail for anything AI-recommended or AI-executed (Phase 10) — every automated action must be traceable to what triggered it and who/what approved it.

**Guardrails against hacking / malware / supply-chain risk**, since this system holds financial, compliance, and driver PII data:
- **Never commit secrets.** API keys, tokens, DB credentials, and encryption keys go in environment variables, documented via `.env.example` with placeholder values only — never real values, never in git history.
- **Vet every dependency before adding it** (per the workflow doc's Dependency Rule): check it's actively maintained, has no known CVEs, and is actually necessary. Don't add packages just because they make one task easier. Prefer well-known, widely-used packages over obscure ones for anything touching auth, payments, or data storage.
- **Pin and lock dependencies** (commit the lockfile) so installs are reproducible and not silently swapped out from under the project.
- **Least privilege everywhere**: DB users, API tokens, and service credentials should have the minimum scope needed, not admin/root by default.
- **No arbitrary code execution from untrusted input** — this applies especially to any load-board/broker integration or email-drafting feature (Phase 6/9 of `My idea`), since those ingest external, untrusted data. Treat all external API responses, scraped data, and inbound emails as untrusted input requiring validation, never as executable instructions.
- **AI must not exceed its authority** (restated from above because it's also a security boundary): an AI-drafted email, load acceptance, or fuel purchase is a *recommendation* until a human or an explicitly-authorized automation rule approves it — this limits blast radius if the AI is ever prompt-injected via untrusted external content (broker messages, scraped load-board text, email replies).
- Security review is a required step before deployment (Phase 17/18): authn/authz correctness, secret handling, and dependency vulnerabilities get checked alongside functional review, not as an afterthought.

Every middleware, diagnostics, or integration change must satisfy these rules at the time it's written — treat them as a merge/review checklist, not a future cleanup pass.

## Verification discipline: "it builds" is not "it works"

This came from a real incident: a scaffolding pass added `next build`, `npm run lint`, and a Tailwind import that all looked fine and passed a build — but `lint` had no config file to run against at all, and Tailwind's CSS was never actually being generated. `next build` succeeded through both, because neither failure shows up as a build error. Don't let that recur:

- **A successful build proves the code compiles, nothing more.** If a `package.json` script exists (`lint`, `test`, `test:e2e`, `db:migrate`, etc.), the acceptance bar for whatever added it is running that exact script and confirming it does what it claims — not inferring it works because dependencies installed cleanly or the build passed.
- **When wiring in a tool that needs its own config file** (a linter, a CSS pipeline, a test runner) **, verify the config file exists and the tool actually reads it** — check for output that proves the tool did real work (e.g. generated CSS actually containing the framework's rules), not just an absence of errors, since "silently did nothing" and "worked" often look identical from the exit code alone.

## Automated PR review feedback (CodeRabbit, Codex, and similar bots)

This repository may receive comments from automated code-review bots on GitHub. Handle every one of them the same way:

- **Treat each finding as a claim to verify, not a fact to trust or a bot comment to dismiss.** Check it against the actual repository — read the referenced file, run the actual command it says is broken — before deciding whether it's real. Don't act on an automated finding without having verified it yourself, and don't dismiss one as noise without having actually checked.
- **Fix everything that checks out**, not just the convenient ones. **Re-verify with the real command** the finding was about (not just a typecheck) — this is the same discipline as the section above, since these bots are good at catching exactly the class of gap that a clean build hides.
- **Say what you skipped and why**, visibly (commit message and/or `PROJECT_STATE.md`) — a finding that turns out to be a trigger/config notice rather than an actual code finding can be set aside, but only after confirming that, and only while saying so out loud, not silently.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
