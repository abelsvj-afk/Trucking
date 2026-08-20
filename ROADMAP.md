# Roadmap

Phase 13 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Translates everything designed in `docs/` into an actual build sequence. This is ordering, not new design — every stage below points back to a document that already specifies it; nothing here introduces a decision that wasn't already made. `TASKS.md` (Phase 14, next) breaks each stage into the small, independently-testable units that actually get implemented.

Sequenced by real dependency, not by the workflow doc's generic example (Foundation → Auth → Core → AI → Integrations → Automation → Optimization → Deployment) — adapted to what this project's architecture actually requires, since testing here is continuous rather than a late bolt-on, and only one AI capability is design-complete enough to build.

## Stage 1 — Foundation

Nothing else works without this. `npm install` and the first real lockfile (deliberately deferred from Phase 12, per `docs/repository-structure.md`); create the actual Supabase project; apply `docs/schemas.md` as real migrations, including every table's RLS policy — RLS is the actual security boundary per `docs/design/security.md`, so it goes in with the schema, not after. Wire `services/db`'s Supabase client per `docs/service-specs.md`.

**Done when:** the database exists with every MVP table, every table's RLS policy passes the tenant-isolation test from `docs/design/testing.md`, and the scaffold from Phase 12 actually boots (`npm run dev` serves the placeholder page).

## Stage 2 — Authentication

Implement `services/auth` per `docs/service-specs.md`: Supabase Auth wiring, session handling, the single-owner account. Every route depends on this, per `docs/api-contracts.md`'s "no endpoint temporarily left open" rule — it has to exist before any real data screen, not alongside one.

**Done when:** an unauthenticated request to any future API route gets `401`, and there's a real login screen (per `docs/design/ui-ux.md`'s Account/Settings) to get a session in the first place.

## Stage 3 — Core functionality (the MVP company database)

The bulk of the build: `services/api` middleware (auth check → validation → `services/db` → response, per `docs/service-specs.md`), then the entities themselves, in dependency order so nothing references a resource that doesn't exist yet:

1. **Trucks, trailers, drivers** — no dependencies on other MVP entities.
2. **Customers, brokers** — no dependencies.
3. **Loads** — depends on trucks/drivers/brokers/customers existing; includes the `draft`/`confirmed`/`completed` status behavior from `docs/design/data-model.md`.
4. **Expenses, fuel purchases, maintenance events** — depend on trucks (and loads, for expenses).
5. **Documents** — depends on whatever entity they attach to.
6. **Financial summary** — depends on loads + expenses + fuel + maintenance all existing, since it's computed from them.

Each entity means: its `services/db` functions, its `/api/v1/...` routes exactly per `docs/api-contracts.md`, and its screens exactly per `docs/design/ui-ux.md` (list/detail/create/edit, all four states — loading/empty/populated/error) — backend and frontend land together, per `CLAUDE.md`'s no-backend-only rule. Not "build all the backend, then all the frontend."

**Done when:** every MVP entity from `docs/requirements.md` is fully usable end-to-end from the actual navigation in `docs/design/ui-ux.md`, and the WCAG 2.1 AA target is met, not deferred to a later pass.

## Stage 4 — Industry intelligence engine

The only AI capability that's design-complete through Phase 10 (`docs/design/ai-architecture.md`, `docs/automation.md`). Build `services/integrations` (its external sources), `services/ai` (the prompt/output contract), the internal cron-trigger route and Vercel Cron config (`docs/runtime.md`), the `industry_briefings` table's endpoints, and the briefing screen (already placeholder-listed in `docs/design/ui-ux.md`). Ships **off by default** — turning it on is the explicit, logged decision `docs/governance.md` requires, not something that happens by deploying the code.

**Done when:** a scheduled run produces a real briefing with a working per-capability kill switch, and the consecutive-failure escalation from `docs/runtime.md` actually surfaces in-app.

## Stage 5 — Hardening

Not a new testing phase bolted on at the end — `docs/design/testing.md` already treats testing as part of every stage above. This stage is specifically the cross-cutting checks that only make sense once the whole MVP exists together: the full RLS tenant-isolation suite across every table (not just as each table was built), end-to-end coverage of every workflow in `docs/user-stories.md`, and the security review `docs/design/security.md`/`CLAUDE.md` require before deployment — authn/authz correctness, secret handling, dependency vulnerabilities, checked as a whole system, not just per-feature.

## Stage 6 — Deployment

Real Vercel + Supabase production environments (per `docs/architecture.md`), real environment variables set from `.env.example`, the Vercel Cron job actually scheduled. Per the workflow doc's Phase 18 checklist: tests passing, build succeeding, docs current, secrets secured, monitoring in place (`docs/runtime.md`'s Vercel/Supabase dashboards), rollback possible (Vercel's own deployment rollback covers this at MVP scale — no custom mechanism needed).

## Beyond the MVP

Every other capability in `docs/vision.md` (decision engine, load profitability, fuel intelligence, home-time engine, email AI, etc.) is real future work, but none of it is roadmapped in detail here — each still needs its own Phase 8 (service spec) and Phase 10 (automation) pass, per the pattern `docs/design/ai-architecture.md` established, before it can be sequenced for real. Listing fake dates or a fake order for undesigned work would be exactly the "speculative architecture" the workflow doc warns against. When the owner picks the next capability to design (the way the industry intelligence engine was picked for Phase 10), it gets added here as its own stage.

---

*`TASKS.md` (Phase 14, next) breaks Stages 1–6 above into small, independently-testable tasks with explicit acceptance criteria — this document sequences the work, that one makes it actionable.*
