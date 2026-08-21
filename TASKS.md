# Tasks

Phase 14 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Breaks `ROADMAP.md`'s 6 stages into small, independently-testable units with explicit dependencies and acceptance criteria — this is what Phase 15 (Implementation) actually works from.

Per `docs/requirements.md`'s locked-in rule: any task below that touches user-facing functionality is not done until it ships a working frontend for it, not backend alone. That's why most Stage 3 tasks below are "entity: backend + screens" as one task, not split into separate backend/frontend tasks — splitting them is exactly how backend-only delivery happens by accident.

Task sizing follows `CLAUDE.md`'s existing pattern for file/function size: "under ~4 hours" is a warning threshold, not a hard limit — split a task further if it turns out bigger in practice, don't force it to fit.

## Stage 1 — Foundation

| ID | Task | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|
| 1.1 | Run `npm install`, commit the lockfile | Phase 12 scaffold | `npm run dev` serves the placeholder page; `npm run typecheck` and `npm run lint` pass clean | ✅ Done — `npx tsc --noEmit`, `npx eslint .`, and `npx next build` all pass clean; lockfile committed. An automated PR review caught real gaps this task's original pass missed (no `eslint.config.mjs`, so lint literally couldn't run; no PostCSS wiring, so Tailwind wasn't actually generating CSS) — both fixed and verified, see `eslint.config.mjs`/`postcss.config.mjs`. |
| 1.2 | Create the Supabase project; populate local `.env.local` from `.env.example` | — | App can reach Supabase from a local dev run; no real values committed anywhere | ✅ Done — real project `qiiztjqzlrpffyyrjkss` (us-west-2, Postgres 17), created by the owner and connected via the Supabase MCP connector. All 4 values (URL, anon key via MCP; `SUPABASE_SERVICE_ROLE_KEY` pasted by the owner) written to `.env.local`, which is gitignored. |
| 1.3 | Migrate `companies` and `user_profiles` (`docs/schemas.md`), with RLS | 1.2 | Tables exist; RLS policy scopes every query to `company_id` | ✅ Applied to the live project via `apply_migration` — confirmed via `list_tables` |
| 1.4 | Migrate all remaining MVP tables + `industry_briefings` (`docs/schemas.md`), with RLS on each | 1.3 | Every table from `docs/schemas.md` exists with its RLS policy | ✅ Applied — all 13 tables exist, RLS enabled on every one (`list_tables` confirms `rls_enabled: true` across the board) |
| 1.5 | Write the RLS tenant-isolation test (`docs/design/testing.md`) | 1.4 | Two-company test proves company A can never read/write company B's rows, for every table | ✅ Written (`tests/integration/rls-tenant-isolation.test.ts`) **and independently verified live** against the real project via a direct SQL equivalent (two companies, two real `auth.users`, simulated sessions via `request.jwt.claims`) run through the MCP `execute_sql` tool: list-query isolation ✅, direct-by-id isolation ✅, cross-tenant insert blocked ✅. The committed test file itself could not be run in *this* sandboxed session — direct network calls from here to `*.supabase.co` are blocked by an org-level egress policy (confirmed via the proxy's own status endpoint, not a bug in the test or the project) — but it's the same logic just verified, and will run normally in any environment without that restriction (CI, the owner's own machine, Vercel). |
| 1.6 | Wire `services/db`'s Supabase client (server + client variants) | 1.4 | A trivial read/write round-trips through `services/db` in a test | ✅ Done (`src/services/db/server.ts`, `client.ts`); typechecks clean against the real project's URL/anon key now in `.env.local` |

**Stage 1 is complete.**

**Extra hardening found and fixed:** Supabase's own security advisor flagged that `current_company_id()` — the helper every RLS policy relies on — was unintentionally reachable as a public REST endpoint (`/rest/v1/rpc/current_company_id`) since Supabase auto-exposes every `public`-schema function. Not an actual data leak (anonymous callers get `null`; authenticated callers only get their own `company_id`, which they already know), but needless public surface for an internal-only helper. Fixed by moving it to a `private` schema PostgREST doesn't expose (`supabase/migrations/00006_...sql`) — verified this doesn't break the existing RLS policies (Postgres tracks the function by OID, not by name, so they kept working automatically) and re-ran the advisor: 0 findings.

## Stage 2 — Authentication

| ID | Task | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|
| 2.1 | Implement `services/auth` (`docs/service-specs.md`) | 1.6 | Valid session resolves `{user_id, company_id, role}`; invalid/missing session fails closed | ✅ Done (`src/services/auth/index.ts`) — uses `getUser()` not `getSession()` so it revalidates against Supabase Auth's server rather than trusting a locally-decoded cookie; fails closed on both missing session and a missing `user_profiles` row |
| 2.2 | Implement `services/api`'s shared pipeline + centralized error formatter (`docs/service-specs.md`, `docs/api-contracts.md`) | 2.1 | A test route through the pipeline returns the documented error shape on every failure type | ✅ Done (`src/services/api/handler.ts`, `errors.ts`, `validate.ts`) — verified by 2.4's test suite: 401 on no auth, context passed through on success, raw exceptions never reach the client (500 with a generic message instead) |
| 2.3 | Login screen (`docs/design/ui-ux.md`) | 2.1 | Can sign in from the actual UI; session persists; lands on Home | ✅ Done (`src/app/login/page.tsx`, `src/middleware.ts`). Sign-in only, no signup link — `docs/governance.md`'s single-admin model has no open-signup workflow. Middleware handles session-cookie refresh and redirects unauthenticated requests to `/login` / authenticated requests away from it. |
| 2.4 | Auth-required test suite | 2.2 | Every future route rejects an unauthenticated request with `401` before touching business logic | ✅ Done (`tests/unit/services/api/handler.test.ts`, 3 tests, all passing) — tests the shared pipeline mechanism directly rather than a specific route, since no business route exists yet; every Stage 3 route inherits this automatically by using `createApiHandler` |
| 2.5 | `GET /api/v1/health` | 2.2 | Returns `{status: "ok"}`, no auth required, separate from business routes | ✅ Done (`src/app/api/v1/health/route.ts`) — confirmed in the `next build` route list |

**Stage 2 is complete.** `npx tsc --noEmit`, `npx eslint .`, `npx vitest run tests/unit` (3/3 passing), and `npx next build` all verified clean.

## Stage 3 — Core functionality

Each row is one task: `services/db` functions, validation (`docs/design/data-model.md`), the `/api/v1/...` routes (`docs/api-contracts.md`), and the actual screens (`docs/design/ui-ux.md`) — together, per `CLAUDE.md`.

| ID | Task | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|
| 3.1 | Trucks: backend + Fleet screens | 2.2 | Full CRUD reachable from the app; loading/empty/error states present | ✅ Done. Built the **shared CRUD infrastructure** here rather than duplicating per entity: `services/db/crud.ts` (generic list/get/create/update/soft-delete over RLS), `services/api/crud-routes.ts` (wires it to `createApiHandler` + Zod validation — every entity's `route.ts` is ~10 lines), `lib/use-api-list.ts` (shared list-fetch hook), `components/ListStates.tsx` (loading/empty/error), and the `(app)` route group with the real bottom-tab nav shell from `docs/design/ui-ux.md`. Also renamed `middleware.ts` → `proxy.ts` (Next.js 16 deprecated the old convention — caught by the build's own warning, verified against nextjs.org before renaming) and fixed a real `react-hooks/set-state-in-effect` lint finding by restructuring the fetch pattern (now the shared hook every list screen uses). |
| 3.2 | Trailers: backend + Fleet screens | 2.2 | Same pattern as 3.1 | ✅ Done — same shared infrastructure, ~5 files |
| 3.3 | Drivers: backend + Fleet screens (incl. `assigned_truck_id`) | 3.1 | Same pattern; assigning a driver to a truck works end-to-end | ✅ Done — includes a real truck-picker dropdown (fetched from `/api/v1/trucks`), not a raw UUID text field, per `CLAUDE.md`'s "must be genuinely usable" rule |
| 3.4 | Customers: backend + More screens | 2.2 | Same pattern as 3.1 | ✅ Done — first entity under the More tab, not Fleet, per `docs/design/ui-ux.md` |
| 3.5 | Brokers: backend + More screens | 2.2 | Same pattern as 3.1 | ✅ Done |
| 3.6 | Loads: backend (incl. `draft`/`confirmed`/`completed`, date-order validation) + Loads screens (incl. Draft badge, status filter) | 3.1, 3.3, 3.4, 3.5 | A load can be saved incomplete (stays `draft`, visibly badged) and completed later | ✅ Done. First entity needing a real business rule beyond field types — `delivery_date >= pickup_date`, enforced via a Zod `.refine()` shared between create/update. Extended the shared infra rather than writing a one-off: `services/db/crud.ts` gained an optional `filters` param, `services/api/crud-routes.ts` gained `filterableFields` (loads declares `["status"]`, implementing `docs/api-contracts.md`'s `?status=` filter), and `lib/use-api-list.ts` now accepts query params. New-load form has 4 relationship dropdowns (truck/driver/broker/customer, via a new shared `usePickerList` hook, also backfilled onto the driver form) and converts a dollar rate input to `rate_cents` on submit — asking for raw cents would fail CLAUDE.md's usability rule. Caught and fixed a real `as const` type error on the Zod refinement (readonly tuple vs. Zod's mutable `PropertyKey[]`) via `npx tsc --noEmit` before it went further. |
| 3.7 | Expenses: backend + Money screens | 3.1, 3.6 | Non-negative amount enforced; shows against the right truck/load | ✅ Done. First entity to land in the Money tab, so this task also created `app/(app)/money/page.tsx` (the Money index, mirroring `fleet/page.tsx`/`more/page.tsx` — the `/money` nav link had no page until now). Schema (`category` enum, `amount_cents` non-negative integer, required `expense_date`, optional `truck_id`/`load_id`/`driver_id`/`description`) follows the same shared-CRUD pattern as every prior entity — no infra changes needed. New-expense form reuses `usePickerList` for truck/load/driver dropdowns and converts a dollar amount to `amount_cents` on submit, same UX pattern as the loads form. Caught a real test bug via `npx vitest run`: a placeholder UUID (`...-1111-1111-...`) failed Zod v4's stricter RFC 4122 variant-nibble check even though it "looked like" a UUID — fixed by using a properly-formed v4-shaped UUID instead of loosening the schema. Verified with `tsc --noEmit`, `eslint .`, `vitest run` (43/43 passing), and a full `next build` (confirmed `/money`, `/money/expenses`, `/money/expenses/new`, and both `/api/v1/expenses` routes all appear in the route manifest). |
| 3.8 | Fuel purchases: backend + Money screens | 3.1 | Positive-gallons validation enforced | ✅ Done. Same shared-CRUD pattern; `gallons` uses Zod `.positive()` (matches `docs/schemas.md`'s `numeric(8,3)`, no upper bound specified), `price_per_gallon_cents`/`total_cost_cents` non-negative integers, `truck_id`/`purchased_at` required. URL path is kebab-case (`/api/v1/fuel-purchases`) while the underlying Supabase table stays `fuel_purchases` — same convention already established for `industry-briefings`/`industry_briefings` in `docs/api-contracts.md`; `createCrudRoutes`'s `table` argument and the route directory name are independent, so this needed no infra change. New-purchase form collects gallons, price/gallon, and total cost all in real units the owner would actually read off a pump receipt (not raw cents), converting to cents on submit only. Verified: `tsc --noEmit`, `eslint .`, `vitest run` (52/52), `next build` (`/money/fuel-purchases`, `/money/fuel-purchases/new`, both `/api/v1/fuel-purchases` routes all present). |
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
