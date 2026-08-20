# Tasks

Phase 14 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Breaks `ROADMAP.md`'s 6 stages into small, independently-testable units with explicit dependencies and acceptance criteria — this is what Phase 15 (Implementation) actually works from.

Per `docs/requirements.md`'s locked-in rule: any task below that touches user-facing functionality is not done until it ships a working frontend for it, not backend alone. That's why most Stage 3 tasks below are "entity: backend + screens" as one task, not split into separate backend/frontend tasks — splitting them is exactly how backend-only delivery happens by accident.

Task sizing follows `CLAUDE.md`'s existing pattern for file/function size: "under ~4 hours" is a warning threshold, not a hard limit — split a task further if it turns out bigger in practice, don't force it to fit.

## Stage 1 — Foundation

| ID | Task | Depends on | Acceptance criteria |
|---|---|---|---|
| 1.1 | Run `npm install`, commit the lockfile | Phase 12 scaffold | `npm run dev` serves the placeholder page; `npm run typecheck` and `npm run lint` pass clean |
| 1.2 | Create the Supabase project; populate local `.env.local` from `.env.example` | — | App can reach Supabase from a local dev run; no real values committed anywhere |
| 1.3 | Migrate `companies` and `user_profiles` (`docs/schemas.md`), with RLS | 1.2 | Tables exist; RLS policy scopes every query to `company_id` |
| 1.4 | Migrate all remaining MVP tables + `industry_briefings` (`docs/schemas.md`), with RLS on each | 1.3 | Every table from `docs/schemas.md` exists with its RLS policy |
| 1.5 | Write the RLS tenant-isolation test (`docs/design/testing.md`) | 1.4 | Two-company test proves company A can never read/write company B's rows, for every table |
| 1.6 | Wire `services/db`'s Supabase client (server + client variants) | 1.4 | A trivial read/write round-trips through `services/db` in a test |

## Stage 2 — Authentication

| ID | Task | Depends on | Acceptance criteria |
|---|---|---|---|
| 2.1 | Implement `services/auth` (`docs/service-specs.md`) | 1.6 | Valid session resolves `{user_id, company_id, role}`; invalid/missing session fails closed |
| 2.2 | Implement `services/api`'s shared pipeline + centralized error formatter (`docs/service-specs.md`, `docs/api-contracts.md`) | 2.1 | A test route through the pipeline returns the documented error shape on every failure type |
| 2.3 | Login screen (`docs/design/ui-ux.md`) | 2.1 | Can sign in from the actual UI; session persists; lands on Home |
| 2.4 | Auth-required test suite | 2.2 | Every future route rejects an unauthenticated request with `401` before touching business logic |
| 2.5 | `GET /api/v1/health` | 2.2 | Returns `{status: "ok"}`, no auth required, separate from business routes |

## Stage 3 — Core functionality

Each row is one task: `services/db` functions, validation (`docs/design/data-model.md`), the `/api/v1/...` routes (`docs/api-contracts.md`), and the actual screens (`docs/design/ui-ux.md`) — together, per `CLAUDE.md`.

| ID | Task | Depends on | Acceptance criteria |
|---|---|---|---|
| 3.1 | Trucks: backend + Fleet screens | 2.2 | Full CRUD reachable from the app; loading/empty/error states present |
| 3.2 | Trailers: backend + Fleet screens | 2.2 | Same pattern as 3.1 |
| 3.3 | Drivers: backend + Fleet screens (incl. `assigned_truck_id`) | 3.1 | Same pattern; assigning a driver to a truck works end-to-end |
| 3.4 | Customers: backend + More screens | 2.2 | Same pattern as 3.1 |
| 3.5 | Brokers: backend + More screens | 2.2 | Same pattern as 3.1 |
| 3.6 | Loads: backend (incl. `draft`/`confirmed`/`completed`, date-order validation) + Loads screens (incl. Draft badge, status filter) | 3.1, 3.3, 3.4, 3.5 | A load can be saved incomplete (stays `draft`, visibly badged) and completed later |
| 3.7 | Expenses: backend + Money screens | 3.1, 3.6 | Non-negative amount enforced; shows against the right truck/load |
| 3.8 | Fuel purchases: backend + Money screens | 3.1 | Positive-gallons validation enforced |
| 3.9 | Maintenance events: backend + Fleet screens | 3.1 | Shows in the relevant truck's maintenance history |
| 3.10 | Documents: upload/storage/signed URLs + per-record browsing UI | 3.1, 3.3, 3.6 | File uploads, is retrievable via signed URL, browsable from its related truck/trailer/driver/load |
| 3.11 | Financial summary: computed endpoint + Home snapshot + Money > Summary screen | 3.6, 3.7, 3.8, 3.9 | Correct revenue/expense/net for a date range; excludes `draft` loads |
| 3.12 | Navigation shell + shared states + accessibility pass | 3.1–3.11 | Bottom-tab nav matches `docs/design/ui-ux.md`; all four states implemented as shared components; WCAG 2.1 AA verified across Stage 3 screens |

## Stage 4 — Industry intelligence engine

| ID | Task | Depends on | Acceptance criteria |
|---|---|---|---|
| 4.1 | `services/integrations`: pick and wire the external source(s) | 1.6 | Real data fetched, treated as untrusted per `CLAUDE.md` |
| 4.2 | `services/ai`: prompt + output contract (`docs/design/ai-architecture.md`) | 4.1 | Produces `summary`/`reasoning`/`confidence`/`based_on`; refuses to produce a recommendation when it can't meet that bar |
| 4.3 | Internal cron-trigger route + Vercel Cron config (`docs/runtime.md`) | 4.2 | Route rejects any request without the cron secret; runs delegate to 4.1/4.2, no logic in the route itself |
| 4.4 | Scoped least-privilege credential for the job (`docs/automation.md`) | 4.3 | Credential can write `industry_briefings` only — verified it can't touch any other table |
| 4.5 | `/api/v1/industry-briefings` (list, dismiss) | 4.4 | Matches `docs/api-contracts.md` exactly; no client-side create |
| 4.6 | Per-capability + global kill switches (`docs/governance.md`) | 4.3 | Off by default; flipping off stops the next scheduled run, not the current one |
| 4.7 | Failure logging + consecutive-failure escalation (`docs/runtime.md`) | 4.3 | A single failure is silent; several consecutive ones surface an in-app notice |
| 4.8 | Industry intelligence briefing screen | 4.5 | Matches `docs/design/ui-ux.md`'s placeholder-listed screen |

## Stage 5 — Hardening

| ID | Task | Depends on | Acceptance criteria |
|---|---|---|---|
| 5.1 | Full-system RLS suite (every table together, not per-entity as built) | Stage 3, Stage 4 | Passes across the whole schema at once |
| 5.2 | End-to-end coverage of every `docs/user-stories.md` workflow | Stage 3, Stage 4 | Normal, alternative/draft, error, recovery workflows all pass in a real browser |
| 5.3 | Security review (`docs/design/security.md`, `CLAUDE.md`) | Stage 3, Stage 4 | Authn/authz, secret handling, and dependency vulnerabilities (`npm audit` or equivalent) checked and clean |
| 5.4 | Accessibility verification pass | Stage 3 | WCAG 2.1 AA confirmed system-wide, not just per-screen at build time |

## Stage 6 — Deployment

| ID | Task | Depends on | Acceptance criteria |
|---|---|---|---|
| 6.1 | Production Vercel + Supabase setup, real env vars | Stage 5 | Production environment mirrors `.env.example`, no dev values leaked in |
| 6.2 | Configure production Vercel Cron for the industry-intelligence job | 6.1, Stage 4 | Scheduled per `docs/automation.md`'s default (max once daily); capability still off by default |
| 6.3 | Pre-deploy checklist (workflow doc Phase 18) | 6.1 | Tests passing, build succeeding, docs current, secrets secured, monitoring confirmed, rollback plan confirmed |
| 6.4 | Go live; update `PROJECT_STATE.md` | 6.3 | Real production URL reachable and usable end-to-end from a phone |

---

*Every task here implements something already fully specified in `docs/`. If implementing a task reveals a real gap or contradiction in the design, stop and fix the relevant doc first, per the workflow's own escalation rule — don't silently improvise inside the code.*
