# Repository & Codebase Architecture

Phase 12 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Turns the `src/` layout `docs/architecture.md` sketched into the actual repository, now that Phases 5–11 give it enough real detail to justify creating it for real rather than speculatively. Repository structure follows architecture, not imagination — every directory below traces to a decision already made in an earlier doc; none are here "because they might be useful."

## What was actually created

```
package.json          — dependencies below, scripts: dev/build/start/lint/typecheck/test/test:e2e
tsconfig.json          — strict: true, per CLAUDE.md's strict-typing guardrail
.gitignore
.env.example            — already existed, from Phase 11

src/
├── app/                — Next.js routes. layout.tsx + page.tsx exist as a minimal,
│                          honestly-labeled placeholder so the scaffold is a valid,
│                          bootable app — not a real screen. Real screens are Phase 15
│                          tasks, per docs/design/ui-ux.md.
│   ├── layout.tsx
│   ├── page.tsx
│   ├── globals.css      — Tailwind v4 (see below)
│   └── api/              — empty; routes get added per docs/api-contracts.md as
│                            Phase 15 tasks build them, including the internal
│                            cron-trigger route from docs/runtime.md
├── components/            — shared UI (e.g. ListStates.tsx), per docs/architecture.md
├── features/               — still empty as of Stage 3 (see note below)
├── services/
│   ├── db/                 — empty; spec already exists in docs/service-specs.md
│   ├── auth/                — empty; spec in docs/service-specs.md
│   ├── api/                  — empty; spec in docs/service-specs.md
│   ├── ai/                    — empty; reserved per docs/design/ai-architecture.md,
│   │                            docs/automation.md — nothing to implement yet beyond
│   │                            the industry-intelligence engine when its task starts
│   └── integrations/           — empty; reserved per docs/architecture.md, first real
│                                  use will be the industry-intelligence engine's sources
├── data/schemas/                 — empty; will hold the Zod schemas implementing
│                                    docs/schemas.md once Phase 15 starts
├── lib/, types/, config/          — empty; small shared utilities, shared types,
                                      env/config loading

tests/
├── unit/           — empty; strategy in docs/design/testing.md
├── integration/     — empty; same, including the RLS tenant-isolation test flagged
│                       there as the single most important test in the suite
└── e2e/               — empty; same
```

Empty directories are held in git with a `.gitkeep` file — Git doesn't track empty directories on its own. Rather than repeating "what goes here" in a README inside every folder (which would just be the same explanation duplicated in fifteen places, drifting out of sync as things change — "one source of truth beats duplicated state," per the workflow doc's Golden Principles), that explanation lives once, here.

## Dependencies chosen, and why

Verified against real current versions rather than guessed, since a wrong major version in a foundational file is expensive to discover later:

| Package | Version | Why |
|---|---|---|
| `next` | 16.3.0 | Already decided in `docs/architecture.md`; current stable/LTS as of this phase |
| `react` / `react-dom` | 19.2.0 | Next 16's paired React version |
| `@supabase/supabase-js` | 2.112.3 | Already decided in `docs/architecture.md` |
| `zod` | 4.4.3 | Already named as the intended validation library in `docs/service-specs.md` |
| `tailwindcss` | 4.3.3 | New decision, made here: Next.js's own `create-next-app` now includes Tailwind by default, it's the natural pairing, and v4 configures via CSS (`@theme`) rather than a separate JS config file — one less config file to maintain. No custom design tokens yet; `docs/design/ui-ux.md` already deferred visual styling to implementation time. |
| `vitest` + `@testing-library/react` | 4.0 / 16.0 | Unit/component testing, per `docs/design/testing.md` |
| `@playwright/test` | 1.49 | End-to-end testing, per `docs/design/testing.md` |

All are established, actively maintained, widely used packages — satisfies the Dependency Rule in `CLAUDE.md`. Versions are declared with `^` ranges in `package.json`; the exact resolved versions get pinned in a lockfile the first time `npm install` actually runs.

## What was deliberately *not* done in this phase

- **No `npm install`, no lockfile.** Generating a real lockfile means actually running the package manager — a network operation with real footprint (downloads, `node_modules`) that belongs at the start of Phase 15 (Implementation), when someone is actually about to write code against these dependencies, not as a side effect of a repository-structure phase. `package.json` declares intent; the lockfile gets committed once Phase 15 begins, per `CLAUDE.md`'s "pin and lock dependencies" rule.
- **No feature code, no route handlers — not even `/api/v1/health`.** Every one of those is real implementation work with its own acceptance criteria; per the workflow doc's master rule, that belongs to Phase 14 (Tasks) and Phase 15 (Implementation), not to a phase about structure.
- **No `GEMINI.md` or `ARCHITECT.md`**, despite appearing in the workflow doc's illustrative minimum structure. `CLAUDE.md` already serves the AI-assistant-guidance role this project actually needs, and there's no separate Gemini-based agent or distinct "Architect" role in use here — adding those files would be following the template literally instead of what `docs/architecture.md`'s "repository structure follows architecture, not imagination" rule actually asks for.
- **No `CHANGELOG.md`, `ROADMAP.md`, or `TASKS.md` yet.** `ROADMAP.md` and `TASKS.md` are named deliverables of Phases 13 and 14, which come next — creating them now would be jumping ahead. `CHANGELOG.md` starts meaning something once there's a real released change to log; an empty stub today would just be speculative scaffolding.

---

## Update from Stage 3 (Phase 15): `features/` stayed empty, and that's a real decision

As Stage 3 built out trucks, trailers, and drivers, entity work landed in `app/(app)/fleet/...` (routing, following Next.js App Router's own convention), `data/schemas/` (validation), and shared `services/db`/`services/api` CRUD infrastructure — not in a per-entity `features/` folder as this document originally sketched. This isn't an oversight: for CRUD-shaped entities with no logic beyond "validate, store, list, edit," there's no distinct feature-specific concern left over that doesn't already have a home in one of those three places. `features/` remains reserved, per `docs/architecture.md`, for whichever future entity actually needs client-side business logic substantial enough to warrant its own module (a candidate: the load-profitability calculations in `docs/vision.md`'s future scope) — not populated speculatively now that a plausible reason not to use it exists.

---

*Next: Phase 13 (Roadmap) sequences implementation into stages; Phase 14 (Tasks) breaks the MVP into the small, independently-testable units that will actually populate the empty directories above.*
