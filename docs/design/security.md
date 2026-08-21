# Security Design

Phase 7 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`, formalizing the security posture already implied by `docs/architecture.md`, `docs/schemas.md`, and the guardrails already standing in `CLAUDE.md`. This is written with the concern you raised early on directly in mind: this system will hold financial and driver PII data, and it must not be an easy target.

## Authentication

Supabase Auth, session via secure HTTP-only cookies — never a token handled/stored by application code. One account today (per the single-admin model in `docs/governance.md`); the mechanism doesn't change when a second account is added later. No endpoint is exempt from requiring a valid session except `/api/v1/health` (per `docs/api-contracts.md`).

## Authorization

Postgres row-level security (RLS), not application-level filtering, is the actual enforcement point: every policy checks that the row's `company_id` matches the requesting user's `company_id` (via `user_profiles`). This matters because it means a bug in a route handler — forgetting a `WHERE company_id = ...` clause — still can't leak another company's data; the database itself refuses the query. Application code enforcing this alone would mean one missed filter is a real breach; RLS means it isn't.

## Secrets

Per `CLAUDE.md`: no secret is ever committed. Concretely:
- Supabase's anon key (safe for the client — RLS is what actually protects data, not key secrecy) lives in a public env var; the service-role key (which bypasses RLS) is used only in trusted server-side code, never sent to the browser, and only where a route genuinely needs elevated access.
- All keys/credentials are documented with placeholders in `.env.example`, real values only in the deployment platform's (Fly.io secrets/Supabase) configuration — updated from an original Vercel assumption when hosting moved to Fly.io during Stage 3 (`docs/architecture.md`).

## Encryption

- **At rest:** handled by Supabase's managed Postgres (encrypted by the provider) — not something this project builds custom crypto for, per the Dependency Rule's "don't build what a vetted provider already does correctly."
- **In transit:** HTTPS everywhere, enforced by Fly.io and Supabase by default (`fly.toml`'s `force_https`); no plain-HTTP path exists.

## Data isolation

Covered concretely by Authorization above (RLS + `company_id`) — restated here because it's the core of what keeps this safe to eventually operate as a multi-tenant product: every table, every query, every row is scoped, from the very first migration, not bolted on when a second company signs up.

## Threat model

| Threat | Mitigation |
|---|---|
| One company reading/writing another company's data | RLS policies on every table, enforced at the database, not just in application code |
| Stolen/leaked session | HTTP-only secure cookies via Supabase Auth; no custom session handling to get wrong |
| Malformed or malicious API input | Every write validated against `docs/schemas.md` before touching the database, per `docs/api-contracts.md`; parameterized queries only — no hand-built SQL, so standard injection doesn't apply |
| Secrets leaking via logs, commits, or error responses | `.env.example` + platform-managed env vars; centralized error handling that never echoes internals (per `CLAUDE.md`) |
| Malicious file upload (`documents`) | Size (25MB max) and declared content-type (an allowlist of PDF/image types appropriate for scanned paperwork) validated server-side before storage; files stored in Supabase Storage under a `company_id`-scoped path, never executed, served only via short-lived signed URLs — never a public bucket. Declared content-type, not byte-level signature sniffing — a deliberate simplicity tradeoff at this app's actual risk level (single authenticated admin, no anonymous write surface, files never executed or served as static assets), not an oversight; revisit if the threat model ever changes (e.g. multiple untrusted users) |
| Future: prompt injection via untrusted external content (broker messages, load-board data, once integrations exist) | Already bounded structurally in `docs/architecture.md` — the AI layer can only read via `services/db`/`services/ai`, and per `docs/governance.md` it can never execute a restricted action regardless of what it's told by external content |
| Brute-force login attempts | Handled by Supabase Auth's built-in rate limiting on auth endpoints — not reimplemented here |

## Abuse prevention

At MVP scale (one user), heavy abuse-prevention infrastructure would be unnecessary complexity. What's in place regardless: Supabase Auth's built-in auth-endpoint rate limiting, and every write endpoint requiring authentication (so there's no anonymous write surface to abuse at all). Broader rate limiting (e.g. per-user request caps) is deferred until there's a real reason for it — multiple users, or a public-facing endpoint — consistent with the "no unnecessary complexity" principle already applied to caching in `docs/architecture.md`.

## Security review

Per `CLAUDE.md` and the workflow doc's Phase 17: authn/authz correctness, secret handling, and dependency vulnerabilities get checked before deployment, alongside functional review — not as a separate afterthought pass.

---

*This document assumes the architecture in `docs/architecture.md` (Supabase-managed Postgres/Auth/Storage) as given. If that choice changes, this document needs to be revisited, not silently left stale.*
