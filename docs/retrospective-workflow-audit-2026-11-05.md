# Retrospective Engineering Workflow Audit — Trucking

**Audit date:** 2026-11-05  
**Repository:** abelsvj-afk/Trucking  
**Audited baseline:** main at ac2099dc4e97d2d12fd05f828a12e24783f6ce87  
**Parent:** 24f192dff83d56145f019f77e461346ac8bd1fdd  
**Latest commit at audit:** “Trip intake Phases B+C: last-shown confirmation targeting, trip fields and tasks”  
**Audit type:** retrospective, source/documentation inventory and workflow-compliance reconciliation  
**Change boundary:** this audit adds findings only. It does not authorize or perform application-code changes, schema changes, migration application, deployment, or edits to existing documents.

---

## 0. Mandatory agent notice

**Architect, Builder, Reviewer, and any other AI or human contributor: read this document before starting new work in Trucking.**

This repository predates the Master AI Engineering & System Development Workflow. The existing implementation is therefore treated as a **legacy baseline to be reconciled**, not as proof that every earlier feature was designed in the required order. The purpose of this audit is to backfill the missing design, requirements, governance, contracts, and verification records so that future changes follow the workflow.

This document is an audit and remediation register. It is **not** blanket approval to implement the listed findings.

- **Architect Agent:** owns the retrospective design reconciliation. Update specifications and architecture first; identify unresolved product decisions; do not implement features.
- **Builder Agent:** do not begin remediation code from this document alone. Wait for the Architect's reconciled design, Reviewer approval, and the owner's explicit authorization for the specific work unit.
- **Reviewer Agent:** independently verify every claim against the exact code/tree and evidence. Reject “the tests passed” or “the migration is safe” claims without the actual gate output or live-environment proof.
- **All agents:** preserve the existing manual Fly.io deployment rule. GitHub Actions are prohibited by the owner's standing project instruction. Do not create or revive a GitHub Actions deployment workflow as part of this reconciliation.
- **Owner:** remains the product authority. No item in this audit changes product scope, AI authority, database state, or deployment state without the owner's separate decision.

### Required implementation handoff discipline

For every future work unit, the agent handoff must state:

1. Exact repository, branch, base SHA, and working SHA.
2. Workflow phase and approved design document(s).
3. Task ID, objective, dependencies, and explicit acceptance criteria.
4. Files and data contracts in scope; files explicitly out of scope.
5. Test commands and exact results from the same tree being handed off.
6. Migration number, whether it is merely committed, scratch-tested, applied to a named live project, and verified.
7. Reviewer verdict and unresolved findings.
8. Deployment state and exact deployed SHA, if deployment is separately authorized.

“Built,” “merged,” “migration applied,” “deployed,” and “verified live” are different states and must never be conflated.

---

## 1. Executive assessment

The repository contains a substantial working application, not a scaffold. It has a broad driver/owner-operator product surface, a large API, Supabase schema and migrations, AI-assisted workflows, Telegram integration, routing, research schedulers, and a meaningful automated test suite.

The retrospective gap is **not that the project has no engineering documentation**. It has many useful design documents and a strong original spec-first foundation. The problem is that the implementation expanded well beyond the original MVP while several foundational documents continued to describe the earlier, much smaller system. Newer design documents were added, but they are not consistently reflected in the central requirements, governance, architecture, schemas, API contracts, service specifications, roadmap, and project state.

The most important finding is therefore:

> **The codebase has outgrown its authoritative design record. There is no single, reconciled description of what the current system is, what each capability is allowed to do, which interfaces and data contracts it owns, how it fails, how it is tested, and what is actually live.**

This creates practical risks:

- Agents can read a correct old document and still make an incorrect change to the current product.
- The same feature can be marked “built” in one document and “not built” in another.
- A new database field can exist in a migration and TypeScript schema while the canonical schema/API documentation remains unaware of it.
- AI authority can be enforced in code but described incorrectly in governance.
- Tenant-isolation claims can exceed the actual test coverage.
- Driver safety requirements can be stronger in the design than in the app-wide implementation.
- The project state can direct agents toward work that is already complete or fail to mention newer blockers.

**Overall retrospective status: PARTIAL COMPLIANCE — significant design foundation exists, but the current product is not yet reconciled to the workflow.**

### Highest-priority remediation

1. Reconcile the product's current purpose, scope, personas, and success criteria.
2. Reconcile AI governance and autonomy with the actual bot, write tools, proposal lifecycle, schedulers, and notifications.
3. Update architecture and service boundaries to describe the real deployed system.
4. Reconcile schemas and API contracts with migrations 00045–00061 and the current code.
5. Complete service specifications and feature-level workflows for every implemented capability.
6. Close driver-safety, tenant-isolation, and production-verification evidence gaps.
7. Replace the stale project state and align roadmap/tasks with the current repository.
8. Create a traceable inventory connecting every screen, API, schema, integration, agent tool, test, and design specification.

---

## 2. Audit baseline and method

### 2.1 Repository snapshot

The audit used the public GitHub repository's current default branch, main, at:

- **SHA:** ac2099dc4e97d2d12fd05f828a12e24783f6ce87
- **Commit author/committer:** Claude
- **Commit date:** 2026-11-05 16:12:55 UTC
- **Commit scope:** trip-intake confirmation targeting, trip fields/tasks, load detail, API routes, schema module, migration 00061, and tests.

The audited repository tree contains approximately:

| Inventory | Observed count |
|---|---:|
| Application page files | 65 |
| API route handlers | 111 |
| Versioned API route handlers | 108 |
| Zod schema modules | 32 |
| Supabase migration files | 51 |
| Unit/component test files | 202 |
| Integration test files | 1 |
| Playwright end-to-end specs | 6 |
| AI evaluation test files | 2 |
| Detailed design documents under docs/design | 13 |

These counts are a repository inventory, not proof that every route/page is complete, every test passes, or every migration is applied.

### 2.2 What was inspected

The audit reviewed:

- The root Master AI Engineering & System Development Workflow.
- README, CLAUDE, PROJECT_STATE, ROADMAP, and TASKS.
- Idea, vision, requirements, user stories, governance, architecture, contracts, schemas, service specifications, runtime, automation, repository structure, and related design documents.
- Current app route/page inventory, API route inventory, schema modules, service modules, migrations, and test inventory.
- Representative Home, Loads, Fleet/HOS, Money, Assistant, Dispatch, Smart Path/Drive, authentication, shared UI, API/auth/data-access, bot, Telegram, scheduler, and trip-intake implementation.
- The latest main commit and the branch list relevant to the previously documented screenshot exposure.

### 2.3 Verification limits

This was a GitHub source/documentation audit. It did **not**:

- Run the application locally.
- Run unit, integration, E2E, accessibility, performance, or AI-evaluation tests.
- Connect to the live Supabase project or inspect its migration ledger.
- Verify the production Fly.io machine's deployed commit.
- Verify Fly secrets, Supabase Vault entries, pg_cron jobs, Realtime publication state, or current scheduler heartbeats.
- Perform a complete authenticated visual walkthrough of all 65 page files on a phone.
- Verify a real Telegram Live Location session or real-world driving behavior.

Test-file counts and code presence must not be presented as passing test evidence. The repository's own historical test reports are not independent test execution by this audit.

---

## 3. Current product inventory

This is the product surface that the design record must describe. The inventory is grouped by user-facing area; it is not a claim that every item has passed acceptance testing.

### 3.1 Main application areas and pages

**Home**
- Owner-operator/driver Home dashboard.
- Duty HUD, time-in-status, HOS clock rings, status actions, Day Log and Paper Log entry points.
- News banner, next-step guidance, active-load/plan information, Day Wrap, money summary, and assistant entry points.
- Live position display when a sufficiently fresh phone position is available.

**Loads**
- Load list.
- New-load form.
- Load detail/edit surface.
- Load lifecycle/status, broker/customer/truck/driver associations, appointment windows, facility links, detention/paperwork context, trip metadata, and trip tasks.

**Fleet**
- Fleet overview.
- Trucks: list, create, detail/edit, truck profile.
- Trailers: list, create, detail/edit.
- Drivers: list, create, detail/edit.
- Static driver checklists.
- Equipment/spares checklist: list, create, detail/edit.
- Maintenance events: list, create, detail/edit.
- Preventative maintenance schedules: list, create, detail/edit.
- Pre-trip inspections: list, create, detail/edit.
- Hours of Service: list, create, detail/edit.
- Paper-log review and paper-log detail/day surfaces.

**Money**
- Money overview.
- Expenses: list, create, detail/edit.
- Fuel purchases: list, create, detail/edit.
- Financial summary and summary detail.
- Truck Fund.

**More**
- Assistant/web chat.
- Brokers: list, create, detail.
- Customers: list, create, detail.
- Dispatch helper and dispatch history/exchanges.
- Documents and document processing.
- Facilities: list and create.
- Game Plan.
- Industry Intelligence.
- Memories.
- Research.
- Settings/account configuration.

**Smart Path**
- Route planning/check.
- Drive Mode, including the moving/glance surface and route-following experience.

**Authentication/account**
- Login.
- Forgot password.
- Password reset/confirmation.

### 3.2 Backend and integration surface

The repository also contains:

- Versioned REST APIs for the primary business resources and newer capabilities.
- Internal scheduler/invoker endpoints.
- A private Telegram webhook.
- Supabase Auth, Postgres, Storage, RLS, and Realtime.
- OpenAI provider abstraction and tool-calling agent loop.
- Shared web/Telegram assistant history and memory.
- Telegram dispatch, photo, voice, and Live Location intake.
- Dispatch extraction and recordable-item staging.
- Paper-log/photo extraction and review.
- Document scanning/extraction and safe image processing.
- Truck-aware route providers and geocoding/places integrations.
- EIA, FRED, GDELT, RSS, NWS, OpenStates, and other research/integration sources.
- Industry-intelligence and Deep Research schedulers.
- Game Plan scheduling and checkpoint workflows.
- Financial summary, tax/IFTA, truck-fund, broker-scorecard, invoice/obligation/credential/follow-up, and other service/API modules.

### 3.3 Traceability gap

There are more API routes and schema modules than there are dedicated screens. That is not automatically wrong: some endpoints are internal, infrastructure-only, or intentionally bot-operated. However, the repository does not yet provide one authoritative matrix classifying every API/schema capability as:

- User-facing page feature.
- Bot/Telegram-only feature.
- Internal scheduler/worker feature.
- Read-only integration.
- Admin/owner configuration.
- Infrastructure-only endpoint.
- Intentionally deferred or not exposed.

This is required to distinguish deliberate service-only capabilities from accidental backend-only delivery.

Examples that need explicit classification include credentials, broker follow-ups, load invoices, recurring obligations, vehicle defects, tax packet/IFTA, load tasks, position, news-image, and internal scheduler endpoints.

---

## 4. Workflow phase-by-phase reconciliation

Status key:

- **PRESENT:** a corresponding document or implementation exists.
- **PARTIAL:** a useful artifact exists, but important current-system scope is missing.
- **DRIFT:** the artifact contradicts the current implementation or newer design.
- **MISSING:** no adequate artifact/evidence was found.
- **NOT VERIFIED:** the repository alone cannot prove the live/runtime state.

### Phase 0 — Problem discovery

**Status: PRESENT, needs revalidation.**

Existing artifact: docs/idea.md.

The document describes the original problem of centralizing trucking operations and supporting the founder's progression toward owner-operator and small-fleet operations. It includes the core user, pain points, alternatives, and success criteria.

**Gap:** the product has since become a driver-facing operating tool as well as a business-management system. The current driver's actual workflows—dispatch assignment intake, stop-by-stop work, paperwork, HOS cross-checking, safe driving interaction, and phone-first operation—need to be reflected in the problem statement and target-user description. The current primary persona should be explicitly distinguished from future fleet/customer personas.

**Architect action:** preserve the original business problem but add the current driver/operator problem and identify which user is primary now.

### Phase 1 — Vision and scope lock

**Status: DRIFT.**

Existing artifact: docs/vision.md.

The vision and long-term direction remain useful. The document defines the original MVP as a company database with no AI or automation.

**Gaps:**
- The current application already includes AI assistant/chat, Telegram, memory, document/photo/voice intelligence, research, Game Plan, route intelligence, and scheduled jobs.
- The original MVP/non-goal framing no longer describes the actual product baseline.
- Success metrics are explicitly “not yet defined.” The workflow requires metrics; these should now be defined or explicitly marked as owner decisions with measurable proposals.
- The distinction between the single-owner internal operating tool and a possible future multi-customer product needs to remain explicit.

**Architect action:** create a versioned current vision/scope statement. Do not silently rewrite history; distinguish original MVP scope from the current product scope and future product ambitions.

### Phase 2 — Requirements

**Status: PARTIAL / DRIFT.**

Existing artifact: docs/requirements.md.

The document has functional, non-functional, UI, security, availability, accessibility, and constraint sections. It correctly establishes that user-facing features need working interfaces and that the app is not an authoritative ELD.

**Gaps:**
- Many implemented capabilities are still described as future scope or are absent: conversational assistant, Telegram workflows, memory, dispatch extraction, trip intake, paper-log review, photo/voice intake, driver positioning, live updates, truck-aware routing, research, Game Plan, and related business workflows.
- Requirements do not provide a complete capability catalogue with explicit acceptance outcomes.
- Performance expectations are too broad for a phone-first driver app with maps, live location, image proxying, and AI.
- Licensing remains unresolved.
- Availability/uptime target remains unresolved.
- Driver safety requirements need to be stated as testable system-wide requirements, not only in a design document.
- Requirements do not classify which actions are safe while moving, parked-only, voice-only, or unavailable without GPS.

**Architect action:** create a current requirements matrix with IDs, priority, measurable acceptance criteria, safety classification, and links to the owning design/service/API/page/test.

### Phase 3 — User stories and workflows

**Status: PARTIAL.**

Existing artifact: docs/user-stories.md.

It covers the original owner-operator data-entry workflows, basic normal/alternative/error/approval/escalation/recovery workflows.

**Gaps:**
- It does not comprehensively describe the current app's user journeys.
- It does not fully specify dispatch-to-load intake, forwarded message interpretation, proposal approval/cancellation/retry, trip task completion, per-stop updates, BOL/seal/trailer photos, dispatcher approval reminders, or broker resolution.
- It does not fully cover assistant/Telegram channel handoff, stale or multiple pending proposals, failed writes, voice/photo/document intake, memory corrections/deletion, or research requests.
- It does not describe the full HOS/paper-log review lifecycle, Drive Mode moving/parked transitions, GPS loss, stale location, route fallback, or screen-off location limitations.
- It does not comprehensively define alternate, failure, recovery, and escalation flows for newer modules.

**Architect action:** create stories and workflow diagrams for every current feature family, including failure and recovery cases. The Trip 1852 dispatch transcript is a concrete acceptance scenario and must be retained as a regression fixture without embedding private operational data in public tests.

### Phase 4 — Governance, safety, and authority

**Status: DRIFT — HIGH PRIORITY.**

Existing artifact: docs/governance.md.

The document defines actors, authority levels, an autonomy ladder, escalation, safety overrides, and revocation. The principles are good.

**Critical contradiction:** governance says the AI layer does not exist and the current system is at Level 1 (observe-only). Current code contains:
- A tool-calling assistant with read and write tools.
- Explicitly requested writes and proposed writes requiring approval.
- Delete actions that are proposal-only.
- Pending action storage and confirmation execution.
- Scheduled unattended research/industry-intelligence work.
- Game Plan scheduled evaluations/checkpoints.
- Telegram messages to the owner and other automated notifications.

The code is not simply observe-only. It includes at least prepare-action and human-approved execution behavior, plus bounded scheduled execution for specific capabilities. The exact autonomy level must be classified per capability, not assigned as one vague global level.

**Additional gaps:**
- No complete current capability-to-authority matrix.
- No central table mapping each tool to read/write/propose/execute/delete permissions.
- No documented owner-visible global stop and per-capability stop verification across all AI/scheduled capabilities.
- Service-role database access exceptions need to be described in the security/authorization model.
- Revocation behavior for Telegram, web chat, research, game plan, memory consolidation, photo/voice processing, and notifications needs one authoritative specification.
- Human approval semantics need to define exactly what is approved, how long approval remains valid, how retries work, and how cancellation differs from deletion.

**Architect action:** update governance before further AI/automation changes. Define authority per capability and action. Do not infer approval from model output or an ambiguous user response.

### Phase 5 — Architecture

**Status: DRIFT — HIGH PRIORITY.**

Existing artifact: docs/architecture.md.

The original architecture is a useful record of the initial Next.js/Supabase/Fly decision, but it describes a much smaller application.

**Contradictions with current code:**
- It says no AI layer is built; the repo has extensive AI services and agent tooling.
- It says external integrations do not exist; the repo has many integration providers and scheduled consumers.
- It describes services/ai as an empty read-only boundary; current AI tools include writes through a proposal/approval lifecycle.
- It describes services/db as the only database access path, while Telegram, game, research, bot, and other services have documented/direct Supabase or Postgres access paths.
- It sketches a features/ domain layout, but src/features remains effectively empty; actual application logic is distributed across app routes, shared components, services, and lib.
- It does not describe the actual runtime topology of the Telegram webhook, in-process schedulers, Supabase pg_cron/pg_net invoker, Realtime, image proxy, voice/photo intake, or background position processing.
- It does not map all current service responsibilities or database access exceptions.

**Architect action:** write an architecture-as-built document or reconcile docs/architecture.md so it accurately describes the current system. Preserve the original decision history where useful, but mark superseded statements. Include runtime/data flows and service boundaries for every major subsystem.

### Phase 6 — System contracts

**Status: PARTIAL / DRIFT.**

Existing artifacts: docs/api-contracts.md and docs/schemas.md, plus TypeScript Zod schemas and SQL migrations.

The API contract and schema documents are substantial and useful.

**Confirmed mismatch from current main:**
- Migration 00061 adds loads.trip_number, broker_reference, deadhead_miles, loaded_miles, pickup_tz, delivery_tz, and the load_tasks table.
- The current TypeScript load schema and load-task schema exist.
- The current API has /api/v1/load-tasks routes.
- docs/schemas.md does not describe the new trip fields or load_tasks.
- docs/api-contracts.md does not describe the new load-tasks API contract.

**Other gaps:**
- Realtime event/table contracts are not consolidated in a dedicated events document.
- Telegram update types, edited-message Live Location semantics, scheduler triggers, and background event contracts need explicit versioned contracts.
- Tool interfaces and proposal state contracts are only partly captured in feature-specific documents.
- Contract changes need a single checklist so migration, Zod schema, API, UI, bot tool, tests, and docs cannot drift apart.

**Architect action:** reconcile all migration 00045–00061 additions against docs/schemas.md, docs/api-contracts.md, and the TypeScript schemas. Add event/tool contracts where needed.

### Phase 7 — Detailed system design

**Status: PARTIAL.**

Existing artifacts include 13 documents under docs/design, including UI/UX, data model, security, testing, AI architecture, Driver MVP, Driver HUD, driver usability, Trip Intake, Research Engine, Gaming System, news images, and Employer Pay Profile.

**Strengths:**
- The app has real driver-specific design work.
- The paper-log-not-ELD boundary is explicit.
- Financial truth and HOS time rules have dedicated contracts.
- Trip intake and confirmation lifecycle now have a dedicated design.
- Research and Game Plan have feature-level designs.

**Gaps and contradictions:**
- The 65-page application surface is not mapped to one current, complete screen-by-screen design and acceptance matrix.
- docs/design/ui-ux.md still frames many screens as the original MVP and lists newer screens/features as not yet designed.
- docs/design/driver-hud.md still lists some capabilities as not built even though newer code/design records say they exist.
- docs/design/driver-usability.md has an “Open, with owners” list that still lists image-led news, background GPS/rerouting, and other items despite newer implementation claims.
- docs/design/news-banner-images.md has a title and body describing a not-built design while its opening status says all phases are built. The implementation and design sections contradict each other.
- docs/design/trip-intake.md contains both a proposed load_stops model and a later “built” description that uses the two load endpoint fields plus load_tasks; it also has a “Decide” section that remains even though a later section says the decisions were approved.
- Memory architecture is spread across bot implementation and Driver MVP material, but no single complete memory design document was found covering short/long-term memory, retrieval, permissions, retention, forgetting/deletion, provenance, correction, and evaluation.
- Voice/photo/document intelligence and other AI subfeatures need clear design ownership and explicit failure/permission contracts.
- A full visual walkthrough of every page, form, detail state, error state, empty state, and moving/parked state has not been evidenced in this audit.

**Architect action:** create a design coverage matrix. For each page and capability, identify the authoritative design, status, unresolved decisions, and test evidence. Resolve contradictory status statements rather than adding another parallel document.

### Phase 8 — Service specifications

**Status: MISSING FOR MUCH OF THE CURRENT SYSTEM.**

Existing artifact: docs/service-specs.md.

It specifies services/db, services/auth, services/api, and a placeholder/reserved services/ai description.

**Critical drift:** the document says none of the services use AI and that services/ai is not implemented. The current repo contains substantial services across:
- AI provider/agent loop/chat/dispatch/transcription/document/photo/paper-log/settlement extraction.
- Bot tools, context, memory retrieval/lifecycle/consolidation, threads, pay advisor, pay truth, and voice corpus.
- Telegram webhook, private bot, photos, voice, albums, notifications, and Live Location.
- Research watchers, scoring, scheduling, triggers, delivery, and health.
- Game Plan scheduler, snapshots, checkpoints, and execution.
- Fleet maintenance, mileage, defects, paper logs, and maintenance outlook.
- Smart Path route checking, routing providers, and fuel estimation.
- Financial summary, tax/IFTA, documents, integrations, and other modules.

**Architect action:** create service specifications for every major module family. Each spec must include purpose, responsibilities, dependencies, inputs/outputs, state, tool/API contracts, permissions, failure modes, recovery, observability, and tests. The existing core service specs should be updated to match current boundaries.

### Phase 9 — Intelligence design

**Status: PARTIAL / DRIFT.**

Existing artifact: docs/design/ai-architecture.md plus feature-specific AI design in Driver MVP, Research Engine, Gaming System, and Trip Intake.

**Gaps:**
- The central AI architecture says no capability has been built and memory is deliberately not designed, while the repository has a mature assistant, memory retrieval/lifecycle, tool registry, photo/voice/document extraction, and multiple AI-backed features.
- Prompt/context/tool architecture is not comprehensively indexed by capability.
- Evaluation strategy is stale: docs/design/testing.md says AI evaluation is not applicable, while tests/eval contains an evaluation harness and live evaluation test.
- Confidence, ambiguity, language selection, stale context, cross-channel identity, tool validation, and failure behavior need a current system-wide contract.
- AI outputs and decisions need consistent auditability and a clear link to the owner action that followed.

**Architect action:** create a current AI capability inventory and per-capability design references. Update the shared AI architecture pattern and testing/evaluation strategy.

### Phase 10 — Automation and autonomy

**Status: PARTIAL.**

Existing artifact: docs/automation.md.

It primarily specifies the industry-intelligence engine's scheduling, approval, audit, revocation, rollback, failure recovery, rate limits, and escalation.

**Gaps:**
- It does not cover the full assistant write/proposal lifecycle.
- It does not fully cover Deep Research, Game Plan, memory consolidation, maintenance watch, photo/voice intake, paper-log proposals, driver-position proposals, or Telegram notifications.
- It does not provide one cross-capability autonomy register.
- The relationship between scheduled autonomous reads/research and user-approved business writes is not consistently described.
- Idempotency, retries, expiry, cancellation, revocation during execution, and partial failure should be standardized by action type.

**Architect action:** define an automation contract for every capability that runs without a direct user request. Document kill switches, schedules, hard limits, audit records, idempotency, rollback/recovery, and owner escalation.

### Phase 11 — Runtime and entrypoints

**Status: PARTIAL / DRIFT.**

Existing artifact: docs/runtime.md, plus Dockerfile, docker-entrypoint.cjs, fly.toml, src/instrumentation.ts, Telegram webhook, internal invoker routes, and schedulers.

**Strengths:**
- Fly.io persistent-process behavior is documented.
- Runtime configuration and environment variables are listed.
- Health, logging, monitoring, and research invoker concepts are documented.
- The phone-accessible manual deploy path is documented.

**Gaps:**
- The document still describes a GitHub Actions deployment path as written/not working. The owner's standing instruction prohibits GitHub Actions; the active project procedure must clearly say manual Fly deployment only.
- The actual runtime entrypoint and all schedulers/invokers need one reconciled inventory.
- The actual state of Supabase pg_cron/pg_net, Vault secrets, research heartbeat, industry scheduler, game scheduler, and Telegram webhook must be verified in the live environment.
- Runtime monitoring and alerting evidence is not equivalent to code presence.
- Fly's current min_machines_running = 0 and auto-stop behavior should be assessed against the driver's availability expectations and scheduled workloads.
- Production deployed SHA is not established by this source audit.

**Architect/King action:** reconcile docs/runtime.md with the actual no-GitHub-Actions deploy policy, then maintain a live runtime verification checklist.

### Phase 12 — Repository and codebase architecture

**Status: PARTIAL / DRIFT.**

The repository has a clear Next.js/TypeScript/Supabase layout, but the documented structure is stale.

**Required workflow structure compared with current main:**

| Required item | Current repository | Assessment |
|---|---|---|
| docs/ | Present | Present |
| src/ | Present | Present |
| tests/ | Present | Present |
| scripts/ | Absent | Missing; create only if architecture needs tracked scripts |
| .github/ | Absent | Deliberate exception: do not add GitHub Actions under the owner's standing rule |
| README.md | Present | Too thin for current product/onboarding |
| CHANGELOG.md | Absent | Missing |
| ROADMAP.md | Present | Incomplete for current feature set |
| TASKS.md | Present | Exists, but status reconciliation needed |
| PROJECT_STATE.md | Present | Stale |
| CLAUDE.md | Present | Present |
| GEMINI.md | Absent | Missing workflow-required agent instructions |
| ARCHITECT.md | Absent | Missing workflow-required Architect instructions |

**Structure drift:**
- docs/repository-structure.md describes features and services as empty/reserved; they are now heavily populated.
- src/features remains empty while product code lives in app routes, components, services, and lib. This may be a valid implementation choice, but the architecture must explicitly accept it or define a migration plan.
- Several files are substantially larger than the workflow's preferred ~300-line warning threshold. Verified examples include the Drive page, load detail page, bot write tools, Telegram dispatch bot, and bot read tools.
- Large files are not automatically wrong, but each should have a documented responsibility boundary and a decomposition plan where it contains multiple responsibilities.
- .mcp.json contains a Supabase project reference. It is not itself a secret credential, but the repo's public configuration should continue to be reviewed for accidental tokens or private environment values.

**Architect action:** update repository structure docs to match the real tree. Do not perform a speculative folder migration. Create only the missing workflow files that the owner authorizes; do not create a GitHub Actions workflow.

### Phase 13 — Roadmap

**Status: PARTIAL / DRIFT.**

Existing artifact: ROADMAP.md.

The roadmap contains Stages 1–6 and explicitly treats other capabilities as future work requiring their own design.

**Gap:** TASKS.md now contains later work stages for Driver MVP, Deep Research, UI/UX, Truck Fund, Abel Job Brain, Intake & Routing, Gaming System, and driver usability. The roadmap does not reconcile these later stages into the current system sequence. It therefore no longer represents the actual build history or remaining work.

**Architect action:** create a current roadmap from the reconciled capability inventory. Separate completed, partially complete, design-only, blocked, owner-decision, and future-scope items.

### Phase 14 — Task generation

**Status: PARTIAL.**

Existing artifact: TASKS.md.

The task file contains many task IDs, dependencies, acceptance criteria, and historical progress notes.

**Gaps:**
- The roadmap/task relationship is no longer one-to-one.
- Some new feature work is described in long narrative blocks rather than a current, dependency-ordered, independently testable task register.
- Some items have conflicting completion status across TASKS, PROJECT_STATE, and design documents.
- Current acceptance criteria do not consistently require cross-layer completion (migration + schema + API + UI/bot + tests + docs + live verification where applicable).
- Task sizing should be reviewed against the workflow's “ideally under four hours” principle. Large tasks should be decomposed before assignment.

**Architect action:** reconcile task statuses against main and live evidence. Keep historical notes, but provide one current actionable task list.

### Phase 15 — Implementation

**Status: PRESENT, PROCESS EVIDENCE INCOMPLETE.**

The application is substantially implemented. The current tree includes 65 pages, 111 API handlers, 32 schema modules, extensive service modules, and 51 migration files.

The repo also contains CLAUDE.md rules requiring spec-first work and no backend-only delivery.

**Gap:** because the project predates the workflow and expanded through many feature waves, there is no complete feature-by-feature evidence chain proving that every current implementation was preceded by the corresponding approved design and current requirements. This is the purpose of this retrospective—not an assumption that every old feature was improperly built.

**Required future rule:** no new feature or behavior change starts from code. It begins with the appropriate requirements/design/contract update and explicit owner approval.

### Phase 16 — Testing

**Status: PARTIAL / NOT VERIFIED LIVE.**

The test inventory is substantial:
- 202 unit/component test files.
- One integration test file for RLS tenant isolation.
- Six Playwright E2E specs.
- Two AI evaluation test files.

**Gaps:**
- This audit did not run any tests.
- The RLS suite does not currently cover all newer tenant-scoped tables. The current integration suite's table coverage does not include at least the newer load_tasks and driver_positions tables, and several later capability tables need a complete inventory check.
- The RLS suite has historically been blocked from direct live execution in the documented sandbox environment. A real test/local Supabase execution and current two-company proof remain necessary.
- The E2E suite covers selected workflows, not the entire 65-page surface or all critical workflows.
- docs/design/testing.md says AI evaluation is not applicable, despite the evaluation harness and current AI capabilities.
- System-wide accessibility verification remains open in PROJECT_STATE.md.
- Performance testing has been deferred; a driver-facing app with map, image, Realtime, and AI paths needs at least defined performance budgets and targeted checks.
- Tests for service-role paths must prove explicit company scoping; ordinary RLS tests do not prove isolation for service-role clients because service-role access bypasses RLS.

**Architect/Reviewer action:** update the test strategy and generate a feature-to-test matrix. Run tests against the exact candidate tree. Run live RLS and service-role isolation tests in a real test environment. Do not claim all-table coverage until every tenant-scoped table is enumerated and exercised.

### Phase 17 — Review

**Status: PARTIAL.**

The project has historical PR descriptions, King/Reviewer audits, test-gate reports, and audit registers.

**Gaps:**
- No single review record format is enforced for every feature.
- A code commit on main is not itself proof of independent review. The current audited head is a direct commit on main; no PR review record for that specific commit was found in the repository history search.
- Architecture/security/AI-authority review evidence is not consistently attached to every new capability.
- Current main should receive a fresh adversarial review after the retrospective docs are reconciled.

**Reviewer action:** require an explicit review verdict and evidence for each remediation task. Review the exact final tree, not a nearby branch or earlier SHA.

### Phase 18 — Deployment

**Status: PARTIAL / NOT VERIFIED LIVE.**

The app is documented as live at https://trucking.fly.dev/ and Fly.io manual deployment is the intended path.

**Gaps:**
- The deployed SHA was not verified during this audit.
- The Supabase live migration ledger was not inspected.
- PROJECT_STATE.md says migrations 00045–00057 need ledger reconciliation and 00058–00061 are not applied; this must be confirmed against the actual project before any assumption is made.
- Live Realtime, Live Location, cron invokers, schedulers, and required secrets need proof-of-life checks.
- Rollback is described through Fly releases, but the actual procedure and last successful rollback rehearsal are not evidenced here.
- GitHub Actions references in runtime documentation must not be treated as the approved deployment path.

**King/Owner action:** verify the production commit, migration ledger, secrets, scheduler heartbeats, webhook configuration, and rollback readiness. Migration application and deployment remain separate owner-authorized actions.

### Phase 19 — Project state management

**Status: DRIFT — HIGH PRIORITY.**

Existing artifact: PROJECT_STATE.md.

The file has valuable history and an owner/King action list, but its current-state fields are stale and contradictory:
- The Last Updated field still says 2026-08-21.
- The document describes the project as being in earlier Stage 4/5 work while main now includes later feature stages and migration 00061.
- Its technical-debt summary says none while the same repository documents substantial open work and unverified production tasks.
- Its migration and deployment status requires current live confirmation.
- Newer TASKS/design records are not consistently reflected in the current phase and next-task summary.

**Architect action:** replace the top-level current-state summary with a concise accurate status while preserving the historical narrative below it. Every meaningful task/merge/migration/deploy updates this file.

### Phase 20 — Iteration and expansion

**Status: PARTIAL / MISSING PROCESS.**

The repository has evolving feature documents and audit registers, but no consistent gate that re-enters the appropriate design phases for every new capability or significant change.

**Architect action:** add a repeatable change-intake checklist to the agent workflow: scope → requirements → governance → architecture/contracts → detailed design → task → implementation → tests → review → deploy → state update.

### Postmortem

**Status: MISSING AS A STANDARD ARTIFACT.**

Historical lessons are embedded in PROJECT_STATE.md, TASKS.md, and PR descriptions, but no repeatable postmortem record was found for major milestones.

**Architect action:** define a short postmortem template for major milestones: what worked, what failed, incorrect assumptions, delays, incidents, technical debt, automation opportunities, and reusable guardrails.

---

## 5. Cross-cutting findings and priorities

### P0 — Privacy exposure closure must be evidenced

PROJECT_STATE.md and docs/audit-register-2026-11-04.md record a public-repository exposure involving 14 real-data screenshots on branch visual-audit-2026-11-04 and an exposed commit SHA beginning cf356393.

**What this audit verified:** the branch search no longer returns visual-audit-2026-11-04. A lookup using the abbreviated SHA recorded in the project document did not resolve as a commit through the GitHub commit endpoint.

**What remains unverified:** whether the full commit object is inaccessible, whether GitHub Support completed any requested purge, and whether any other refs/forks/caches retain the content. The branch's absence alone is not proof of complete purge.

**Owner/King action:** locate the full SHA and any GitHub Support confirmation. Close this item only with evidence that the exposed content is no longer retrievable. Do not reproduce or re-upload the exposed screenshots.

### P1 — Canonical product documents are stale

The requirements, vision, architecture, governance, service specs, testing strategy, roadmap, and project state do not consistently describe the current implementation. This is the root documentation problem.

### P1 — AI authority is not represented accurately

The current AI layer can read, prepare, propose, and—after the required human approval or direct owner instruction—write records. Separate schedulers execute bounded scheduled jobs. Governance must classify each capability and action, not state that no AI exists.

### P1 — Database/API contracts are out of sync

Migration 00061 is present in code, but docs/schemas.md and docs/api-contracts.md do not yet describe the trip fields/load_tasks contract. This is a concrete example of why the full migration-to-contract reconciliation is required.

### P1 — Tenant isolation evidence is incomplete for the current schema

The integration test's existing table inventory does not include all tables added by later migrations. Newer tenant-scoped tables must be added to the RLS test matrix. Service-role paths require separate company-scope tests because RLS is bypassed by that credential.

### P1 — Driver safety is not consistently applied to every form

The current design distinguishes moving and parked modes and says unknown speed must not unlock controls. The app-wide MotionLock is not equivalent to a fully fail-closed lock across every screen: its own code comments state that it only watches GPS when permission is already granted, and that unknown/no-permission states are handled more strictly only on the HUD and Drive surfaces. The driver-HUD design also records that other forms/pages are not yet covered by the motion gate.

**Required outcome:** reconcile the product rule and implementation for every interactive page. Unknown speed, stale location, or absent permission must never accidentally be treated as proof that the vehicle is parked. Any exception must be explicitly designed, justified, and tested.

### P1 — Production state is not established by the repository

Migration files, scheduler code, Realtime subscriptions, and environment-variable documentation do not prove production configuration. Confirm the real Supabase migration ledger, service-role boundaries, Fly secrets, Realtime publication, Telegram webhook, pg_cron invokers, scheduler heartbeat, and deployed SHA.

### P2 — Current UI/UX design does not cover the full app

The app has 65 page files. The original UI/UX design is centered on the earlier MVP and the driver-specific documents do not provide a complete state-by-state specification for every current screen. The previous visual audit covered only a subset of the app. A full screen inventory and visual/accessibility verification pass remains necessary.

### P2 — API-only features need a deliberate classification

For every API/schema feature without a corresponding page, record whether it is intentionally bot-only, internal-only, or missing a usable UI. No feature should be called complete merely because a route and table exist when the owner is expected to interact with it through the app.

### P2 — Large files need responsibility review

The repository contains files well above the preferred ~300-line guideline. Verified examples include the Drive page, load detail page, Telegram dispatch bot, bot read tools, and bot write tools. Decompose only where it improves cohesion and testability; do not mechanically split files or change behavior during this audit.

### P2 — Test strategy and evidence need reconciliation

Update testing.md to cover current AI evaluation, service-role isolation, newer RLS tables, driver motion states, Telegram lifecycle, Live Location, routing fallback, and critical multi-step workflows. Define performance and accessibility gates appropriate to a phone-first driver app.

### P3 — Repository onboarding artifacts are incomplete

The workflow-required CHANGELOG.md, GEMINI.md, and ARCHITECT.md are absent. README.md is a short product overview rather than an operational onboarding guide. scripts/ is absent. The .github/ directory is absent; this is not permission to add GitHub Actions, which remain prohibited by the owner's standing rule.

---

## 6. Current feature/design traceability register

This section is the starting point for the Architect's feature-by-feature reconciliation. It is not a declaration that a feature is complete.

| Feature family | Existing design/reference | Current reconciliation needed |
|---|---|---|
| Home dashboard / HUD | docs/design/ui-ux.md, driver-hud.md, driver-usability.md | Reconcile current component order, active load, HOS clocks, live position, motion gate, and actual live-data behavior |
| Loads and load lifecycle | docs/design/ui-ux.md, data-model.md, record-lifecycle.md, money-and-revenue.md | Include every current load field, lifecycle rule, trip field, task, paperwork, detention, and financial relationship |
| Trip/dispatch intake | docs/design/driver-mvp.md, docs/design/trip-intake.md | Reconcile proposal identity, cancellation, retry, broker resolution, 00061, load_tasks, appointment zones, multi-stop scope, language behavior, and source evidence |
| Fleet/trucks/trailers/drivers | docs/design/ui-ux.md, data-model.md, driver-mvp.md | Map all screens, profiles, photos, mileage propagation, credentials, defects, and RLS |
| HOS/paper logs | docs/time-and-hos.md, driver-hud.md, driver-usability.md, driver-mvp.md | Reconcile ELD disclaimer, carrier configuration, day graph, photo review, approval, unknown spans, moving safety, and live proof |
| Maintenance/equipment/pre-trip | docs/design/ui-ux.md, data-model.md, driver-mvp.md | Add service specs and full workflows for events, schedules, defects, checklist, inspections, mileage, and photo pairing |
| Money/financial summary | docs/money-and-revenue.md, data-model.md, api-contracts.md | Preserve existing money truth; reconcile fuel, expense, revenue, contribution margin, snapshots, truck fund, tax/IFTA, invoices, obligations, and employer pay |
| Documents/photo intelligence | driver-mvp.md, record-lifecycle.md, security.md | Define document lifecycle, extraction, image classification, upload/cleanup, retention, access, failure/retry, and user review |
| Assistant/web chat | driver-mvp.md, ai-architecture.md, governance.md | Update AI authority, tool catalogue, grounding, memory, confirmation, audit, revocation, error and recovery behavior |
| Telegram bot | driver-mvp.md, trip-intake.md, runtime.md | Define private-chat trust boundary, webhook authentication, channel handoff, proposals, photos, voice, Live Location, notifications, and rate limits |
| Memory/threads/people | driver-mvp.md and bot implementation | Create a complete memory and conversation architecture: source, provenance, permissions, retrieval, supersession, retention, correction, deletion, and tests |
| Smart Path/Drive Mode | driver-mvp.md, driver-usability.md, driver-hud.md | Reconcile truck-routing providers, route legality claims, HOS, stops, rerouting, spoken guidance, motion gate, screen-off limits, and GPS fallback |
| News/Industry Intelligence | research-engine.md, ai-architecture.md, news-banner-images.md | Fix contradictory image-design status; define current data/image contract, source provenance, SSRF protection, rotation, scheduler, kill switch, and freshness |
| Deep Research | research-engine.md, automation.md, runtime.md | Define watchers, triggers, source trust, scheduler/pg_cron, heartbeat, failure escalation, access, and cost caps |
| Game Plan | gaming-system.md | Define scheduled decision authority, trigger inputs, checkpoints, notifications, assumptions, and revocation |
| Integrations | ai-architecture.md, research-engine.md, driver-mvp.md | Create an integration inventory with credentials, data ownership, rate limits, privacy, fallback, timeout, retries, licensing, and live-verification status |
| Authentication/account | security.md, runtime.md, ui-ux.md | Verify full login/recovery/change-password flows, session refresh, secret injection, and owner access |
| API/internal endpoints | api-contracts.md, service-specs.md | Map all 111 handlers to auth class, request/response contract, service, schema, UI/bot consumer, and tests |

---

## 7. Required remediation sequence

Do not run parallel implementation lanes while the underlying specifications are contradictory. The recommended order is:

### Wave 0 — Establish truth

1. Confirm main SHA and working branch for all agents.
2. Verify the public screenshot exposure closure using the full SHA and GitHub Support evidence.
3. Verify production Fly deployed SHA.
4. Verify the live Supabase migration ledger, including 00045–00061.
5. Verify Fly secrets, Supabase Vault, Realtime publication, Telegram webhook, pg_cron/pg_net jobs, scheduler heartbeats, and two-company isolation.
6. Record what is actually live, what is code-only, what is migration-only, and what is unverified.

**No migration or deployment is authorized by this audit.**

### Wave 1 — Reconcile product definition

Architect updates, with owner review:
1. docs/idea.md — current driver/operator problem and personas.
2. docs/vision.md — current scope, non-goals, success criteria/metrics.
3. docs/requirements.md — complete capability requirements and safety/non-functional acceptance.
4. docs/user-stories.md — all current user and agent workflows.
5. docs/governance.md — capability/action authority, approval, revocation, escalation.

### Wave 2 — Reconcile architecture and contracts

Architect updates:
1. docs/architecture.md — actual current system and service boundaries.
2. docs/service-specs.md — every major current service/module.
3. docs/schemas.md — all migrations and current Zod schema fields.
4. docs/api-contracts.md — every current API route, including load tasks.
5. Event/tool contracts — Realtime, Telegram, scheduler, proposal lifecycle, and internal invokers.
6. Security design — service-role exceptions, tenant scoping, secrets, retention, and threat model.

### Wave 3 — Reconcile feature design and UI/UX

For each feature family in section 6:
1. Identify every page and state.
2. Identify every API and schema.
3. Identify every bot/agent tool and external integration.
4. Define normal, alternative, error, approval, cancellation, escalation, and recovery workflows.
5. Define moving/parked interaction rules and accessibility behavior.
6. Identify missing UI or explicitly classify the feature as internal/bot-only.
7. Resolve conflicting design status and owner decisions.

### Wave 4 — Reconcile test and review gates

1. Update docs/design/testing.md.
2. Enumerate every tenant-scoped table and test RLS.
3. Add service-role company-scope tests.
4. Add E2E coverage for critical user journeys, not just selected CRUD flows.
5. Add AI evaluation cases for grounding, language, proposal identity, stale proposals, tool errors, and memory.
6. Add accessibility and performance acceptance gates.
7. Require independent Reviewer signoff on the exact candidate tree.

### Wave 5 — Reconcile roadmap, tasks, and project state

1. Rebuild ROADMAP.md from the approved current architecture.
2. Reconcile TASKS.md into small, dependency-ordered, independently testable tasks.
3. Update PROJECT_STATE.md with the actual current phase, completed, in-progress, blocked, next tasks, known issues, technical debt, and current date.
4. Add CHANGELOG.md and the missing agent instruction files only after owner approval.
5. Establish a postmortem record for major completed milestones.

### Wave 6 — Implementation only after approval

Only after the owner approves the reconciled design and the specific tasks may the Builder implement remediation. Every task must follow the Master Workflow's pre-read list, update tests/docs/project state, and be reviewed before any separate merge, migration, or deployment approval.

---

## 8. Agent-specific instructions

### Architect Agent — next responsibilities

1. Treat this audit as the starting register, not as a final architecture.
2. Produce a canonical current-state feature matrix and a document ownership map.
3. Resolve the P1 governance, architecture, contract, RLS, safety, and production-state gaps first.
4. For every finding, state: evidence, impact, owner, dependency, required decision, proposed design change, and acceptance criteria.
5. Keep historical decisions and superseded designs traceable; do not erase useful history.
6. Do not write implementation code.

### Builder Agent — constraints

1. Do not begin code remediation from this audit alone.
2. Do not edit the existing requirements, architecture, governance, schema, API contract, or roadmap until the Architect has proposed the changes and the owner has approved them.
3. Do not create migrations or apply migrations without separate authorization.
4. Do not add GitHub Actions.
5. Do not deploy.
6. When implementation is authorized, work one approved task at a time and report the exact SHA and test evidence.

### Reviewer Agent — required challenge areas

1. AI authority versus governance.
2. Service-role database access and company scoping.
3. RLS coverage for all tenant-scoped tables, including newer migrations.
4. Driver motion lock behavior for unknown/stale/no-permission states.
5. Telegram confirmation and retry behavior, including multiple pending proposals and cross-channel history.
6. Trip intake schema/API/documentation alignment.
7. Live Realtime, Live Location, scheduler, and production migration proof.
8. User-facing completeness for API/schema features.
9. Accessibility and phone-first interaction across all screens.
10. Documentation accuracy against the exact source tree.

---

## 9. Acceptance criteria for closing this retrospective

This retrospective should not be marked complete merely because this document exists. The reconciliation is complete when:

- [ ] Every current page and major feature has a named owner design document and current acceptance criteria.
- [ ] Every API route and schema has an explicit consumer classification and a documented contract.
- [ ] All migrations are reconciled against docs/schemas.md and the live migration ledger.
- [ ] Governance accurately describes every current AI capability, tool permission, scheduled action, approval rule, and revocation path.
- [ ] Architecture and service specifications describe the actual current implementation and runtime.
- [ ] All contradictory “built/not built/open” statements are resolved.
- [ ] The driver moving/parked safety policy is consistent across requirements, design, code, and tests.
- [ ] RLS tests cover every tenant-scoped table; service-role paths have separate company-isolation tests.
- [ ] Critical workflows have passing unit, integration, E2E, and AI evaluation evidence as applicable.
- [ ] System-wide accessibility and targeted performance gates have been executed and recorded.
- [ ] Production deployed SHA, migration state, secrets, schedulers, Realtime, Telegram webhook, and rollback readiness are verified.
- [ ] ROADMAP.md, TASKS.md, and PROJECT_STATE.md agree on what is complete, in progress, blocked, and next.
- [ ] Reviewer has independently accepted the reconciled documentation and evidence.
- [ ] The owner has approved the next implementation scope.

---

## 10. Final conclusion

Trucking has a strong amount of working software and a meaningful set of design artifacts. The engineering workflow now needs to catch up with the product that was actually built.

The goal is **not** to rewrite the application simply because it predates the workflow. The goal is to understand it, document it accurately, identify unsafe or unsupported behavior, and establish one reliable source of truth for every feature and agent.

Until the P1 reconciliation is complete, agents must not treat old documents as authoritative when they contradict the current code. When code, documentation, and live production disagree, record the disagreement and verify the truth; do not silently choose whichever version is easiest to implement.

**Master instruction to all agents: backfill the design before changing the implementation. The code is the current artifact, not the specification.**

---

## 11. Reviewer addendum — King (2026-11-05)

Added by King (the owner's personal agent; Reviewer/migration operator in this
repository's two-agent setup) after reading this audit against live evidence
the audit itself states it did not inspect (§2.3). Items are corrections and
evidence, not new scope.

### 11.1 Live migration ledger (probe-verified)

Verified against the live Supabase project (organization "Trucking-OS",
project ref `qiiztjqzlrpffyyrjkss`) by object-existence probes — signature
tables/columns/functions, not the `schema_migrations` table:

- **Applied and verified:** every migration file on main through **00062**,
  including 00041–00044 (Units A–C), 00045–00050 (photo/maintenance/paper,
  settlements, threads, voice), 00051 (R-6), 00052–00057 (GAP), 00058
  (Realtime publication), 00059 (paper-log save), 00060 (driver positions),
  00061 (trip intake) and 00062 (load stops). Final probes: 2026-11-04 and
  2026-11-05.
- **Not applied:** **00063** (`employer_pay_profiles`) — the only unapplied
  migration file on main as of 2026-11-05 (probe `m00063 = false`).

This supersedes the PROJECT_STATE.md statement quoted in Phase 18
("00045–00057 need ledger reconciliation; 00058–00061 are not applied").
That statement is incorrect for the live project.

### 11.2 Employer pay profile seed — owner correction and required fix

The Builder landed `00063_employer_pay_profiles.sql` **with a seed insert**
(`employer_name 'Steven'`, 55 cents/mile, for every company without a
profile) in commit `8fbedf4` (2026-11-05 16:54 UTC). The decision history,
in the owner's own sequence:

1. The design doc's default proposed seeding; the owner initially approved
   the package (2026-11-05 ~11:15 AM Eastern).
2. The owner **reversed the seed decision** (2026-11-05 ~11:52 AM Eastern):
   no employer name or rate may appear in the code or migrations — the app
   is employer-agnostic; current terms are live data only.
3. The build commit landed ~2 minutes after the reversal, before the
   correction reached the Builder — a relay-timing collision, recorded
   here so the state is not misread as defiance or as approval.

**Current state:** the seed is on main in an **unapplied** migration
(§11.1). **Required fix, before any application of 00063:** the Builder
removes the seed insert and the "owner-approved seed" header claim from
`00063_employer_pay_profiles.sql` (editing an unapplied migration is the
legitimate route; do not renumber — 00063 remains the pay-profile
migration). After the corrected file lands, King applies 00063 and creates
the current employer's profile row **as live data** in the database, where
it is editable like any other data and appears in no commit.

### 11.3 P0 privacy exposure — evidence update

- Branch `visual-audit-2026-11-04` was **deleted by King on 2026-11-04**
  after the review completed; deletion verified by remote ref listing
  (the branch no longer exists), consistent with this audit's own branch
  search.
- Full exposed commit SHA: `cf356393a36be843e26af83061ab06968527682f`.
- **No GitHub Support purge has been requested** as of this addendum. Per
  §5 P0's own closure standard, the item remains **OPEN** on exactly that
  point: branch deletion is evidenced; commit-object purge is not.

### 11.4 Owner rulings already in force (inputs to the Phase 4 reconciliation)

Governance reconciliation should encode these decided rules rather than
rediscover them:

- Abel has **no slash commands, ever** — intent is inferred from
  conversation — and the backend must **proactively self-report** when
  something is broken.
- Quiet-hours doctrine (OP-03, 2026-11-03): reports/digests wait for
  morning; time-sensitive alerts (law, weather, safety) deliver
  immediately.
- Paper-log Telegram approval, **as amended by the owner 2026-11-04**:
  flagged (0.80–0.95 confidence) stretches and partial days may book via
  Telegram; stretches that cannot be read are dropped and named, never
  filled; the approval prompt names the flagged stretches.
- Pay truth: pay terms are editable per-employer **data** (per company),
  never code — see §11.2.
- FMCSA watcher endgame: fixes ship; **one production poll** is the
  evidence; if the feed still refuses from production, the drop decision
  returns to the owner with that evidence. No relay/proxy workarounds
  without a fresh owner decision.
- Providers are **free-first**; GitHub Actions are prohibited; deploys are
  manual via the Fly web UI; no UTC in anything user-facing
  (America/New_York).

### 11.5 Agent coordination already exists

`CLAUDE.md` (capability and coordination section merged 2026-11-04, PR
#27) already documents the two-agent protocol — King's capabilities
(browser-applied migrations, Fly web-UI deploys, connected-account
operations) and how work is handed between agents. The Architect should
reconcile `GEMINI.md`/`ARCHITECT.md` (Phase 12) against that section
rather than create a parallel protocol.

### 11.6 Deployed state — verified portion only

Fly release **v46** (2026-11-05) was verified in the audit lane, including
the app-shell version stamp read back from production (the stamp
mechanism whose absence previously left the owner's phone serving a
stale shell). Main has advanced beyond that release since; the deployed
SHA for current main is **not** verified by this addendum and remains a
Wave 0 item.

### 11.7 Numbering correction

Reconciliation ranges in §1, §6 and Phase 6 that end at migration 00061
should read **00045–00063**: 00061 is trip intake, 00062 is load stops,
00063 is employer pay profiles.

### 11.8 Postscript (King, 2026-11-05) — §11.1/§11.2 items closed

- The §11.2 required fix landed: the seed insert and the "owner-approved
  seed" header claim were removed from `00063_employer_pay_profiles.sql`
  (commit `5c1ce508`); the file on main is structure-only.
- King applied 00063 on 2026-11-05 (probe-verified) and created the
  current employer's profile **as live data** (55 cents/mile, effective
  2026-11-03; mile_basis, worker_type and fuel_paid_by NULL/unset). No
  employer name or rate exists in the repository.
- Migration 00064 (thread role rewrite, from the employer-agnostic code
  pass) was applied by King the same day; verification counts show zero
  stored person-named role values in `forward_threads` and
  `forward_thread_messages`.
- The live migration ledger is therefore complete: every migration file
  on main (00001–00064) is applied and verified. Since this audit's
  baseline, the employer-agnostic code pass (`03db21f6`, `d59a0048`) and
  the Wave 1–3 documentation reconciliation (`36ee0cbd`, `3fbd5b3f`,
  `fcc7573d`) have also landed.

### 11.9 Deployed state (King, 2026-11-05)

Closing the §11.6 open item as far as the available evidence allows:
Fly release **v48** was deployed 2026-11-05 17:35 UTC (rolling,
Complete, both machines started) and the app answered live requests at
check time. Fly does not label releases with a source commit, so the
exact source SHA is not provable from the dashboard; every commit after
the last code commit (`209b5511`) is documentation-only, so production
is running current code, including the employer-agnostic pass.

### 11.8 Builder addendum — Claude (2026-11-05, at `main` 3144aa7)

Added by the Builder after the reconciliation work; additive, nothing above is edited. Findings are tracked with status, evidence and owner in `docs/reconciliation/audit-closure-checklist.md` (table "Every original finding"). Corrections to this document's own premises: `ROADMAP.md` exists (reconciled with a current-state section); migrations through 00065 are applied and 00067 (revoke anonymous writes) is new; Fly v48 does not contain current `main`; unknown/stale location deliberately does not lock app-wide forms (decision D-12 open). The audit remains OPEN.

