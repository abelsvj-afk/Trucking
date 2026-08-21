# Service Specifications

Phase 8 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`, defining the exact behavior of each service module established in `docs/architecture.md`'s "Service / module boundaries." Deterministic logic first — none of these services use AI; `services/ai` stays a reserved, unimplemented boundary until Phase 9 gives it something real to do.

## services/db

**Purpose:** the only code allowed to touch Postgres directly. Every feature reaches the database through this and nothing else.

**Responsibilities:** CRUD for every MVP entity in `docs/schemas.md`; enforcing the business-rule validation from `docs/design/data-model.md` (date ordering, non-negative amounts, draft-load exclusion) before any write; computing the financial summary aggregation.

**Dependencies:** the Supabase client chosen in `docs/architecture.md`.

**Inputs:** already-validated request data from `services/api`; entity IDs/filters for reads.

**Outputs:** entity records/lists shaped exactly per `docs/schemas.md`; the computed financial-summary object per `docs/api-contracts.md`.

**Tools:** Supabase's Postgres client only — no second database access path.

**Permissions:** always operates under the authenticated user's session, so Postgres RLS applies automatically — it never uses the Supabase service-role key (which bypasses RLS) for ordinary reads/writes. That key is reserved for narrow, explicitly justified server-only operations; none exist yet, so none are specified here. At Governance Level 1, this service never writes anything the human didn't directly request through the API.

**Failure modes:** database unreachable; constraint violation (e.g. a foreign key referencing a soft-deleted or nonexistent row); a cross-tenant access attempt.

**Error handling:** never lets a raw database error escape upward — translates known failures into typed results `services/api` turns into the standard error response in `docs/api-contracts.md`. On a cross-tenant access attempt: because RLS filters *at the query level*, another company's row is indistinguishable from a row that doesn't exist — this always surfaces as "not found," never as "forbidden," so a request can't be used to probe whether a given ID belongs to someone else's company. (`docs/api-contracts.md`'s `403` is reserved for a future case — a role, once more than one exists per `docs/governance.md`'s access model, that can see a row but isn't allowed to write it — not for tenant isolation, which is always `404`.)

**State:** stateless per request; no in-memory caching, matching the no-caching decision in `docs/architecture.md`.

**Interfaces:** one typed function per entity per operation (list/get/create/update/soft-delete), matching `docs/schemas.md`'s fields.

**Testing requirements:** per `docs/design/testing.md` — unit tests for the business-rule validators, and the RLS tenant-isolation integration test, which is this service's single most important test.

## services/auth

**Purpose:** the only code that determines who's making a request and what company/role they belong to.

**Responsibilities:** validate the Supabase session on every request; resolve the authenticated user's `company_id` and `role` from `user_profiles`; produce a `401` before any handler logic runs if that fails.

**Dependencies:** Supabase Auth, via `@supabase/ssr` — the package Supabase publishes specifically for cookie-based sessions in a Next.js App Router server/client split (per `docs/design/security.md`'s HTTP-only cookie session commitment); not `@supabase/supabase-js` alone, which doesn't handle SSR cookie sessions correctly.

**Inputs:** the request's session cookie.

**Outputs:** an authenticated context (`user_id`, `company_id`, `role`) passed to the rest of the request pipeline, or an explicit rejection — never a partial or guessed context.

**Tools:** Supabase Auth's session-handling client — no custom session logic, per `docs/design/security.md`.

**Permissions:** read-only against `user_profiles`; never creates or modifies a session itself outside Supabase Auth's own flows.

**Failure modes:** missing/expired session; a session whose `user_profiles` row is missing (should not happen, but must not be assumed away).

**Error handling:** fails closed, always. A missing or ambiguous authorization context is treated as denied — never as "fall back to no company scope" or any other guess. This is the one place in the system where a silent failure would be a real security bug, not just a bug.

**State:** stateless; relies entirely on Supabase-managed session state.

**Interfaces:** a single function used as the first step of every route in `services/api`.

**Testing requirements:** per `docs/design/testing.md` — every route rejects an unauthenticated request with `401` before touching business logic.

## services/api

**Purpose:** the shared request pipeline every route passes through. This is where `CLAUDE.md`'s middleware rules ("no endpoint temporarily left open," "centralized error handling") actually get implemented, not just restated.

**Responsibilities:** for every request, in order: (1) `services/auth` check, (2) input validation against the request shapes in `docs/api-contracts.md`, (3) call into `services/db`, (4) format the result or error into `docs/api-contracts.md`'s standard response shapes.

**Dependencies:** `services/auth`, `services/db`, and a schema-validation library. None is locked in `docs/architecture.md`, so this is the first new third-party dependency named at this phase — the intended choice is **Zod** (widely used, actively maintained, works naturally with TypeScript's strict typing already required by `CLAUDE.md`), subject to a final Dependency Rule check at implementation time.

**Inputs:** raw HTTP requests.

**Outputs:** HTTP responses conforming exactly to `docs/api-contracts.md` — no route is allowed to return an ad hoc shape.

**Tools:** Next.js route handlers (per `docs/architecture.md`), the validation library above.

**Permissions:** none of its own — it only orchestrates `services/auth` and `services/db`, never bypasses either.

**Failure modes:** validation failure, auth failure, a failure bubbling up from `services/db`, an unexpected exception.

**Error handling:** the single place in the system that formats errors into the `{ error: { code, message } }` shape from `docs/api-contracts.md`. The real error (with detail) is logged server-side — structured, no secrets or PII, per `CLAUDE.md`'s diagnostics rule — while the response the client sees is always the generic, documented shape. Never both.

**State:** stateless per request.

**Interfaces:** one handler per route defined in `docs/api-contracts.md`.

**Testing requirements:** per `docs/design/testing.md` — full create/read/update/soft-delete round-trips per resource, validation-rejection tests, and the auth-required test from `services/auth` above.

## services/ai (reserved — not implemented)

**Status:** Governance Level 1 (per `docs/governance.md`) — nothing here is built. This entry exists only to record the constraints it must satisfy *when* it is built (Phase 9, Intelligence Design), so they aren't decided ad hoc at that point:

- Reads only through `services/db` — never a direct database connection, never a shortcut around RLS.
- Any write path it eventually needs goes through the same `services/auth` → validation → `services/db` pipeline every other write uses — no special case for AI-originated writes.
- Every Level 5/6 capability built here ships with its own per-capability kill switch, per `docs/governance.md`'s revocation model — not optional, not added later.
- Specifically for the industry-intelligence engine (`docs/vision.md`): scheduled, not continuous; off by default; and if its schedule becomes self-adjusting, that adjustment is bounded by an owner-set minimum/maximum interval — unbounded self-adjustment of its own operating cadence is a form of self-expanded authority, which `docs/governance.md`'s core rule forbids regardless of how low-risk the output is.

No further detail is specified here — the real spec for whatever gets built first belongs to Phase 9, once there's an actual capability to design against instead of a placeholder.

---

*These specs assume `docs/architecture.md`'s service boundaries and `docs/schemas.md`/`docs/api-contracts.md`'s contracts as given. A change to any of those requires revisiting this document, not letting it go stale.*
