# Runtime & Entrypoint

Phase 11 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Defines how the system actually runs, on top of the stack chosen in `docs/architecture.md`. Runtime orchestration stays a thin layer — business logic still lives in `services/*`, never here.

## Runtime model: serverless, not a persistent process

Next.js on Vercel means there's no long-running app process to reason about the way a traditional server would have one — each HTTP request is its own serverless function invocation. This matters because it changes what "startup" and "shutdown" even mean here (see below), and it's *why* `docs/architecture.md` already decided against caching — there's no persistent process to hold a cache in.

## Interfaces

- **HTTP:** the `/api/v1/*` routes in `docs/api-contracts.md`.
- **UI:** the web app screens in `docs/design/ui-ux.md`, served from the same deployment.
- **Internal-only:** the industry-intelligence job's trigger route (below) — not part of the public API surface, since no client ever calls it.
- No CLI, no device-specific interface at MVP — the native app wrapper is explicitly future scope per `docs/architecture.md`.

## Startup behavior

There isn't a startup sequence to design. Each serverless invocation initializes only what that one request needs (e.g. a Supabase client), cheaply — there's no in-memory state or cache to warm, and nothing in this system is meant to be "running continuously" for the app to work.

## Shutdown behavior

No explicit shutdown — Vercel manages function lifecycle. What actually matters is that a function timing out never leaves a half-applied write. That falls out naturally from the MVP's writes being simple, single-row operations (per `docs/schemas.md`) rather than needing new runtime machinery to guarantee it.

## Configuration & environment handling

`.env.example` (added alongside this document) documents every required variable with placeholder values only — real values live in Vercel's/Supabase's environment configuration, never in the repository, per `CLAUDE.md`.

| Variable | Where it's used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | safe to expose — RLS is the real protection, per `docs/design/security.md`, not key secrecy |
| `SUPABASE_SERVICE_ROLE_KEY` | server only | bypasses RLS; used only for the industry-intelligence job's scoped write (`docs/automation.md`) — never sent to the client |
| `ANTHROPIC_API_KEY` | server only | used by `services/ai`, per `docs/design/ai-architecture.md` |
| `INDUSTRY_BRIEFING_CRON_SECRET` | server only | see below — lets the scheduled trigger route verify it's actually being called by the scheduler |

## The industry-intelligence job's actual trigger mechanism

`docs/automation.md` established *that* this job runs on a schedule; this is the concrete answer to *how*: a **Vercel Cron Job** (native to the hosting platform already chosen — no new dependency) configured to call a dedicated internal route, `POST /api/internal/industry-briefing/run`, on the interval `docs/automation.md` specifies. That route:

1. Verifies the request carries `INDUSTRY_BRIEFING_CRON_SECRET` — rejects anything else with `401`. No user session is involved, since no human is present when it fires, but the "no endpoint temporarily left open" rule from `CLAUDE.md` still applies in full.
2. Checks the capability's on/off switch (`docs/automation.md`'s Revocation) — exits immediately if off, before doing anything else.
3. Delegates to the actual job logic in `services/ai`/`services/integrations`. The route itself is a thin trigger, not a place for business logic, per this phase's own rule.

This route is deliberately absent from `docs/api-contracts.md`'s resource list — it's not something any client ever calls.

## Health checks

`GET /api/v1/health` (already defined in `docs/api-contracts.md`) is the runtime health check this phase requires — confirmed here, kept separate from business endpoints, no auth required.

## Logging

Structured logs (per `docs/service-specs.md`/`CLAUDE.md` — no secrets, no PII) go to Vercel's built-in function log output. No separate logging service at MVP — adding one before there's a real need would violate the Dependency Rule.

## Monitoring

Vercel's built-in request/function dashboard and Supabase's database dashboard are the MVP monitoring surface, matching the "dedicated error-tracking service deferred" decision already made in `docs/architecture.md`.

This closes a real gap `docs/automation.md` left open: it required that "several consecutive failures" of the industry-intelligence job escalate to the owner, without saying how. Concretely: each run's outcome is part of the audit log already required by `docs/design/ai-architecture.md`; a consecutive-failure count read from that log is surfaced as an **in-app notice** the next time the owner opens the app — not a push notification or email, since that would be a new integration needing its own Dependency Rule justification that isn't warranted yet. Upgrading to a push notification later is an easy addition if in-app turns out to be too slow to matter — not a redesign.

## Recovery behavior

No write path assumes success. User-facing failures follow the standard error contract in `docs/api-contracts.md`; the background job's failures are logged and left for the next scheduled attempt, per `docs/automation.md`. Nothing here adds new recovery machinery — this phase just confirms the same failure discipline already specified per-service holds system-wide.

---

*Business logic lives in `services/*`, per `docs/architecture.md`. This document defines how requests and scheduled triggers reach it and how the system behaves at its edges — not what happens once a request is inside.*
