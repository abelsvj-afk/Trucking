# Runtime & Entrypoint

Phase 11 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Defines how the system actually runs, on top of the stack chosen in `docs/architecture.md`. Runtime orchestration stays a thin layer — business logic still lives in `services/*`, never here.

## Runtime model: a persistent process, not serverless

**Updated during Stage 3** when the owner chose Fly.io over the original Vercel decision (see `docs/architecture.md`). This section originally described a serverless model; Fly.io runs the app as a long-running Node.js process inside a Docker container (`Dockerfile`, `fly.toml`), the opposite of what was assumed when this document was first written. That reversal is exactly why this section — and several others below — needed a real update rather than a silent rewrite once the hosting decision changed.

Concretely: one Node process boots when the Fly.io machine starts, serves every request for as long as the machine stays up, and (per Fly.io's `auto_stop_machines`/`auto_start_machines` config in `fly.toml`) can be stopped when idle and restarted on the next request — so "always running" isn't guaranteed, but a single request is always handled by an already-booted, warm process, not a fresh cold start per request the way serverless was. This is also why the industry-intelligence job's trigger mechanism (below) changed: a persistent process can run its own in-process timer, which serverless genuinely could not.

## Interfaces

- **HTTP:** the `/api/v1/*` routes in `docs/api-contracts.md`.
- **UI:** the web app screens in `docs/design/ui-ux.md`, served from the same deployment.
- **Internal-only:** the industry-intelligence job's trigger route (below) — not part of the public API surface, since no client ever calls it.
- No CLI, no device-specific interface at MVP — the native app wrapper is explicitly future scope per `docs/architecture.md`.

## Startup behavior

The container's entrypoint (`docker-entrypoint.js`) prerenders static pages (`next build --experimental-build-mode generate`) before starting the server (`npm run start`) — a real, if minimal, startup sequence now, unlike the serverless model this document originally assumed. Nothing else needs to initialize eagerly: Supabase clients are still created per-request (`src/services/db/server.ts`/`client.ts`), not held as a long-lived singleton, so a request right after boot behaves the same as one an hour later. There's still no in-memory cache to warm, per `docs/architecture.md`'s caching decision — that decision was justified independently of the runtime model and doesn't need revisiting just because a persistent process could now technically hold one.

## Shutdown behavior

Fly.io stops a machine after the idle period configured in `fly.toml` (`auto_stop_machines`), or on deploy. What matters, same principle as before even though the mechanism changed: a shutdown mid-request must never leave a half-applied write. That still falls out of the MVP's writes being simple, single-row operations (per `docs/schemas.md`) rather than needing new runtime machinery — this held for serverless timeouts and holds here too.

## Configuration & environment handling

`.env.example` (added alongside this document) documents every required variable with placeholder values only — real values live in `fly secrets set` (Fly.io's encrypted app secrets, replacing Vercel's environment-variable UI) and Supabase's own configuration, never in the repository, per `CLAUDE.md`.

| Variable | Where it's used | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | client + server | safe to expose |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | client + server | safe to expose — RLS is the real protection, per `docs/design/security.md`, not key secrecy |
| `SUPABASE_SERVICE_ROLE_KEY` | server only, migrations/admin tooling | bypasses RLS entirely — full access to every table. **Not** used by the industry-intelligence job; that would violate its least-privilege requirement (`docs/automation.md` task 4.4) — see `INDUSTRY_BRIEFING_DB_URL` below |
| `INDUSTRY_BRIEFING_DB_URL` | server only | the industry-intelligence job's actual scoped credential — a `postgres://` connection string for a dedicated Postgres role that can write `industry_briefings`/`industry_briefing_runs` and read its own kill-switch state, nothing else (`docs/automation.md` task 4.4), never sent to the client. Connected to directly via `pg`, not through the anon-key/PostgREST path — there's no user session for an unattended job to run under |
| `OPENAI_API_KEY` | server only | used by `services/ai`'s OpenAI provider, per `docs/design/ai-architecture.md` — required for the industry-intelligence engine to run |
| `ANTHROPIC_API_KEY` | server only | reserved for a future Anthropic provider implementation behind the same `services/ai` interface — not used by any capability yet |
| `EIA_API_KEY` | server only | free-tier key for the EIA Open Data API, `services/integrations`' fuel-market source (`docs/design/ai-architecture.md`'s worked example) |
| `INDUSTRY_BRIEFING_CRON_SECRET` | server only | no longer required for scheduling itself (see below — the job now triggers in-process) but kept for the optional manual-trigger debugging route |

## The industry-intelligence job's actual trigger mechanism

`docs/automation.md` established *that* this job runs on a schedule; this is the concrete answer to *how* — **changed** from the original Vercel Cron Job design now that the runtime is a persistent process rather than serverless. Fly.io has no built-in cron-job primitive equivalent to Vercel's, but a persistent process doesn't need one: an **in-process scheduler**, started once when the server boots (via Next.js's `instrumentation.ts` hook — the framework's own supported "run this once when the server starts" mechanism), calls the job logic in `services/ai`/`services/integrations` directly, in-process.

**Refined during implementation (task 4.3), a real correctness fix, not the original sketch:** `fly.toml`'s `auto_stop_machines`/`min_machines_running = 0` means the Fly machine can stop when idle and restart on the next request — so "started once when the server boots" can happen many times a day under normal traffic, not once. A naive `setInterval` that just fires the job on every boot would silently blow past `docs/automation.md`'s "no more than once daily" bound. Instead: the scheduler wakes up on a short, frequent check-in cadence (every hour), and each wake-up asks the database (via `industry_briefing_runs`, not in-memory state that wouldn't survive a restart anyway) whether enough time has actually passed since that company's last run before doing any real work. This makes the schedule correct regardless of how often the process restarts, rather than trusting a timer that resets on every reboot.

Consequences of this being simpler than the serverless design it replaces:

- No HTTP round-trip, no `INDUSTRY_BRIEFING_CRON_SECRET`-authenticated route needed for the schedule to work — there's no external caller to authenticate, since the same process that's already running triggers itself.
- The capability's on/off switch (`docs/automation.md`'s Revocation) is checked by the scheduler before each run, same requirement as before, just invoked in-process instead of as the first step of a route handler.
- A manually-triggerable route (`POST /api/internal/industry-briefing/run`, secret-authenticated, same as originally designed) is still worth keeping *for debugging* — being able to force a run without waiting for the interval — but it's no longer part of the scheduling mechanism itself, just an operational convenience.

This route (if kept) stays deliberately absent from `docs/api-contracts.md`'s resource list — it's not something any client ever calls.

## Health checks

`GET /api/v1/health` (already defined in `docs/api-contracts.md`) is the runtime health check this phase requires — confirmed here, kept separate from business endpoints, no auth required.

## Logging

Structured logs (per `docs/service-specs.md`/`CLAUDE.md` — no secrets, no PII) go to Fly.io's built-in log aggregation (`fly logs`). No separate logging service at MVP — adding one before there's a real need would violate the Dependency Rule.

## Monitoring

Fly.io's built-in dashboard/`fly status` and Supabase's database dashboard are the MVP monitoring surface, matching the "dedicated error-tracking service deferred" decision already made in `docs/architecture.md`.

This closes a real gap `docs/automation.md` left open: it required that "several consecutive failures" of the industry-intelligence job escalate to the owner, without saying how. Concretely: each run's outcome is part of the audit log already required by `docs/design/ai-architecture.md`; a consecutive-failure count read from that log is surfaced as an **in-app notice** the next time the owner opens the app — not a push notification or email, since that would be a new integration needing its own Dependency Rule justification that isn't warranted yet. Upgrading to a push notification later is an easy addition if in-app turns out to be too slow to matter — not a redesign.

## Recovery behavior

No write path assumes success. User-facing failures follow the standard error contract in `docs/api-contracts.md`; the background job's failures are logged and left for the next scheduled attempt, per `docs/automation.md`. Nothing here adds new recovery machinery — this phase just confirms the same failure discipline already specified per-service holds system-wide.

---

*Business logic lives in `services/*`, per `docs/architecture.md`. This document defines how requests and scheduled triggers reach it and how the system behaves at its edges — not what happens once a request is inside.*
