# Architecture

Phase 5 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. This designs the system without implementing it, building on `docs/requirements.md` (what it must do) and `docs/governance.md` (what the AI layer is and isn't allowed to do). Technology choices below are driven by three explicit decisions you made: free/near-free hosting to start, a mobile-friendly web app now with a native app-store version planned in ~1–3 years once you're an owner-operator using it, and a solo-founder who wants it built and working with lean, high-signal explanation rather than a full teaching pass on every decision.

## System overview

A single web application: a phone-friendly frontend for entering and viewing trucking business data, backed by a managed Postgres database, with no AI layer built yet (Governance Level 1 — observe only, per `docs/governance.md`). One codebase, one deployment, one database — deliberately, because a solo founder maintaining multiple services has more to manage than the business itself justifies at this scale.

## Component architecture

- **Frontend** — a responsive web app (installable to a phone home screen as a PWA) covering the MVP data domains from `docs/requirements.md`: trucks, trailers, drivers, loads, expenses, fuel, maintenance, customers/brokers, documents, and a financial summary.
- **Backend** — server-side logic colocated in the same codebase as the frontend (see "Repository architecture"), behind the middleware stack `CLAUDE.md` already requires (auth, validation, error handling).
- **Database** — managed Postgres, holding all MVP entities plus documents (as file storage).
- **AI layer** — not built. Reserved as an explicit future boundary (see "Service boundaries") so that when it is built, it can only ever read through the same services the backend uses — it gets no shortcut path to the database.

## Technology choices and why

| Concern | Choice | Why |
|---|---|---|
| Frontend framework | **Next.js (React)** | One of the most widely-used, well-documented web frameworks — easiest to get unstuck on when learning. Supports PWA installability now and can be wrapped for iOS/Android app stores later via Capacitor without rebuilding the UI (see "Mobile and app-store path"). |
| Backend | **Next.js route handlers**, same repo | Avoids standing up and paying for a second service. Keeps deployment to one thing. Revisit only if a real reason to split it out shows up. |
| Database | **Postgres via Supabase** | Supabase bundles a managed Postgres database, authentication, and file storage behind one free tier — meaningfully less to wire up and secure yourself than assembling separate auth/storage/DB providers, and it's a widely-used, actively-maintained platform (satisfies the Dependency Rule in `CLAUDE.md`). |
| Hosting | **Vercel (app) + Supabase (data)** | Both have free tiers that comfortably cover a single operator or small fleet's usage, and both scale to paid tiers later without a migration. |
| Auth | **Supabase Auth** | Don't hand-roll authentication for a system holding financial and PII data — use a vetted, widely-used provider instead, per the security guardrails in `CLAUDE.md`. |

Nothing here is locked in stone if a real problem shows up with it — but each has a reason, per the workflow doc's rule that "every major technology choice should have a reason."

## Repository architecture / folder structure

Single repository. The target `src/` layout, selected from the workflow doc's illustrative pattern (only the parts this project actually needs — not scaffolded until Phase 12/15 actually build them):

```
src/
├── app/            # Next.js routes — one section per MVP data domain
├── components/     # shared UI building blocks
├── features/       # trucks, loads, expenses, fuel, maintenance, documents, financial-summary
├── services/
│   ├── db/         # Supabase/Postgres access — the only layer allowed to touch the database
│   ├── auth/       # authentication/authorization logic
│   ├── api/        # shared request middleware: auth check, validation, error handling
│   └── ai/         # reserved, empty until Governance Level 2+ — see Service boundaries
├── data/
│   └── schemas/    # data contracts (Phase 6)
├── lib/            # small shared utilities
├── types/          # shared TypeScript types
└── config/         # environment/config loading
```

`tests/`, `scripts/`, `.github/`, and `.env.example` follow the workflow doc's required top-level structure. No `hooks/` or `state/` directories are added yet — a single-user CRUD app doesn't need them, and the "no speculative architecture" rule means they wait until a real need shows up.

## Service / module boundaries and responsibility mapping

- **`features/*`** own presentation and domain-specific logic for one entity family (e.g. `features/loads` owns everything about viewing/entering loads). No feature reaches into another feature's internals — shared logic goes in `services/` or `lib/`.
- **`services/db`** is the only code allowed to query Postgres directly. Features call it; they never hold a database client themselves. This is what makes the eventual AI layer safe to add — it reads through this same boundary, never around it.
- **`services/auth`** is the only code that checks who's logged in and what they're allowed to do. Every API route depends on it before touching business logic — no exceptions, per `CLAUDE.md`'s middleware rule.
- **`services/api`** holds the shared request-handling middleware (auth check → input validation → business logic → centralized error handling) that every route passes through, per `CLAUDE.md`.
- **`services/ai`** is an intentionally empty boundary right now. It exists in the architecture so that when the AI layer is designed (Phase 9/10, Governance Level 2+), it has a predetermined home that can only read via `services/db` and can never write, execute, or bypass `services/auth` — the boundary is decided now specifically so it isn't scattered into feature code later.

## Data flow

```
Phone/browser
   -> Next.js frontend (features/*)
   -> Next.js API route
   -> services/api middleware (auth check -> input validation)
   -> services/db or services/auth
   -> Supabase (Postgres + file storage)
   -> response back up the same path
```

No step is skipped for convenience — a feature never calls Supabase directly, and no route handles a request without going through the middleware stack first.

## Database design

Relational schema in Postgres, one table family per MVP entity from `docs/requirements.md` (trucks, trailers, drivers, loads, expenses, fuel_purchases, maintenance_events, customers, brokers, documents). Exact columns are a Phase 6 contract (`docs/schemas.md`), not decided here — but one structural decision belongs at the architecture level:

**Every table is scoped by a `company_id` from day one**, even though there's exactly one company (yours) using the system today. This isn't speculative — it's a direct, cheap-now/expensive-later consequence of the app-store product plan you described: retrofitting tenant isolation onto a schema that was never designed for it means migrating every table and rewriting every query later. Adding the column and the access policy now costs almost nothing; skipping it now and needing it in a year means a rewrite. Everything else about the schema stays as small as the MVP actually requires.

## API design

A plain JSON REST-style API via Next.js route handlers — one resource per MVP entity (`/api/trucks`, `/api/loads`, etc.). No GraphQL: it would add a query layer and tooling this single-operator, entity-per-resource system doesn't need. Exact request/response shapes, validation rules, and error formats are a Phase 6 deliverable (`docs/api-contracts.md`), not decided here.

## Authentication strategy

Supabase Auth, starting with a single account (you). Every API route requires a valid session before any handler logic runs — no endpoint is ever "temporarily" left open, per `CLAUDE.md`.

## Authorization strategy

Postgres row-level security policies scoped by `company_id` and role. Today that resolves to "the one owner sees the one company's data," but the policy shape already supports the access model `docs/governance.md` describes for the future (e.g. a view-only collaborator) without a redesign — it's the same tenant-scoping decision from "Database design" applied to access control.

## External integrations

None exist at MVP. When future integrations arrive (fuel-price feeds, load boards, email), they get their own module under `services/integrations/`, and per `CLAUDE.md` every response from them is treated as untrusted input requiring validation — never as instructions, and never given a direct path to `services/db` or `services/ai`.

## Caching strategy

None. A single operator's data volume doesn't need it, and adding a cache layer without a real performance problem to justify it is exactly the "unnecessary complexity" the workflow doc warns against. Revisit if and when it's actually a bottleneck.

## Deployment strategy

Vercel auto-deploys the app from the repository's main branch; Supabase hosts the managed database. No separate CI/CD pipeline beyond what Vercel provides by default — that's proportionate to a solo founder's current needs, and can grow once there's a team or release cadence that needs more.

## Mobile and app-store path

Building a responsive, installable web app now (rather than a native app, or two separate codebases) is the direct architectural answer to "web now, app-store product in 1–3 years": a well-built responsive React app can later be wrapped for the iOS and Google Play stores (e.g. via Capacitor) without rewriting the UI. Choosing React Native or a native codebase now would mean building the interface twice for no near-term benefit — that gets revisited only if the eventual app-store wrap turns out to need capabilities a wrapped web app genuinely can't provide.

## Scalability plan

The current architecture comfortably handles solo-to-small-fleet scale on free tiers. The `company_id` tenant-scoping decision above is the main lever for scaling into a paid, multi-operator product later; raw compute/storage scales by upgrading Vercel/Supabase tiers, not by rearchitecting the system.

## Observability

Per `CLAUDE.md`: structured logs from API routes with no secrets or PII in them, a dedicated health-check route separate from business endpoints, and (once any AI capability exists) an audit trail for anything AI-recommended. Vercel's built-in request logging is the baseline; a dedicated error-tracking service is deferred until real usage justifies the added dependency (Dependency Rule).

## Risks

- **Solo-founder maintenance burden.** Mitigated by choosing a mainstream, heavily-documented stack (Next.js, Supabase) so help is easy to find while you're still learning.
- **Free-tier limits.** Usage should be monitored as real data volume grows; the non-goals in `docs/vision.md` already rule out the kind of heavy scraping/high-traffic patterns that would blow through a free tier early.
- **AI authority creep.** Mitigated structurally, not just by policy: the `services/ai` boundary and `services/db`-only data access mean any future AI code physically cannot reach the database or execute anything outside what `docs/governance.md` authorizes.
- **Native app-store transition risk.** Kept low by building one responsive web codebase now instead of two UIs, so the eventual wrap is additive, not a rewrite.

## Technical debt prevention

- Contracts written in Phase 6 (`docs/api-contracts.md`, `docs/schemas.md`) become the source of truth code must conform to, per `CLAUDE.md`.
- Strict TypeScript across the codebase, per the "strict typing" engineering guardrail.
- The `company_id` tenant-scoping decision is the one deliberate build-for-a-stated-future-need choice in this document, made because the future need (a paid multi-tenant product) is something you've already committed to, not a guess. Everything else here follows the smallest thing that satisfies the current MVP requirements.

---

*This document defines the system's shape. Exact schemas, API request/response formats, and error contracts are Phase 6 (`docs/api-contracts.md`, `docs/schemas.md`). Detailed screen-by-screen UI/UX design is Phase 7 (`docs/design/ui-ux.md`).*
