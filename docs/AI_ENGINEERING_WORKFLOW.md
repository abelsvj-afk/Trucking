# AI_ENGINEERING_WORKFLOW.md

> **Canon in this repository** — copied verbatim from `Brain-Soumaya-V1`
> (`docs/AI_ENGINEERING_WORKFLOW.md`) on 2026-11-05 by the owner's directive, and
> adopted as standing canon for the Trucking repository alongside
> `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. In this repo the quick
> day-to-day mandate is the root [`AGENTS.md`](../AGENTS.md); this document is the
> full lifecycle it derives from. The owner's exception rule in `AGENTS.md`
> (strict adherence by default; owner-authorized workarounds from time to time)
> applies to this document.

> **MANDATORY — standing workflow for this repository, ongoing.** Both coding agents
> (Claude and `agy`) follow this for all substantive work. It supersedes ad-hoc
> "vibe coding." The lighter root [`WORKFLOW.md`](../WORKFLOW.md) is the quick
> day-to-day loop; this is the full lifecycle it derives from.

## Purpose

This document defines the standard workflow for all software projects.

The goal is to eliminate random development, reduce technical debt, improve
architecture quality, and allow multiple AI agents to collaborate effectively.

**Rule #1: NO CODE IS WRITTEN UNTIL DESIGN IS COMPLETE.**

---

## Development Lifecycle

Every project follows:

Idea → Vision → Requirements → User Stories → UX Design → Architecture → Roadmap →
Tasks → Implementation → Testing → Review → Deployment → Postmortem

Never skip stages.

---

## Phase 1: Idea Discovery

Before creating code, answer:

- What problem does this solve?
- Who is the target user?
- Why would someone use it?
- What makes it valuable?
- What is the simplest version that provides value?

**Deliverable:** `docs/idea.md`

Template: Project Name · Problem Statement · Target User · Core Value Proposition ·
Success Criteria · MVP Definition

---

## Phase 2: Vision

Create a high-level vision document.

**Deliverable:** `docs/vision.md`

Template:
- **Mission** — What is this product trying to accomplish?
- **Users** — Who benefits from this?
- **Core Features** — List only essential features.
- **Future Features** — List features excluded from MVP.
- **Success Metrics** — How will success be measured?

---

## Phase 3: Requirements

Create detailed requirements.

**Deliverable:** `docs/requirements.md`

Template:
- **Functional Requirements** — What the system must do.
- **Non-Functional Requirements** — Performance · Security · Scalability ·
  Reliability · Accessibility
- **Constraints** — Budget · Hosting · Third-party services · Licensing

---

## Phase 4: User Stories

**Deliverable:** `docs/user-stories.md`

Template:
- As a user, I want to ______ so that ______.
- As an administrator, I want to ______ so that ______.

---

## Phase 4.5: UI/UX Design

NO IMPLEMENTATION YET. Design only — same rule as Architecture.

A screen does not get built until it has a layout/wireframe description and a
defined empty/loading/error state. "We'll style it after" is not allowed. This
phase exists because skipping it is exactly how a project ships pages that are
structurally correct but visually broken or unusable — passing every functional
acceptance criterion while still looking unfinished.

**Deliverable:** `docs/ux-design.md`

Must include:
- **Design System** — Color palette with explicit semantic roles (primary,
  success, warning, danger, neutral, disabled) — not just a component library's
  defaults. Every semantic state must have an assigned, contrast-checked color
  before any screen is built.
- **Component Inventory** — Every reusable UI component (buttons, cards, forms,
  modals, nav, tables, badges) and which states each must support: default,
  hover, active, disabled, loading, error, empty.
- **Screen Inventory / Wireframes** — A layout description for every screen in
  the MVP — what's on it, where navigation lives, what the primary action is.
- **Navigation Map** — How a user moves between every screen, explicitly. If a
  screen isn't on this map, it doesn't get built — and if it's reachable, it must
  be reachable from somewhere a user can actually click, not just by typing a URL.
- **Empty / Loading / Error States** — For every screen that displays data: what
  it looks like with zero data, while loading, and on error — defined before the
  page is written.
- **Responsive Behavior** — How each screen adapts at mobile/tablet/desktop.
- **Accessibility Baseline** — Minimum contrast ratios, keyboard navigation,
  visible focus states, alt text requirements.

---

## Phase 5: Architecture

NO IMPLEMENTATION. Design only.

**Deliverable:** `docs/architecture.md`

Must include: System Overview · Folder Structure · Database Design · API Design ·
Authentication Strategy · Authorization Strategy · Service Boundaries · External
Integrations · Caching Strategy · Deployment Strategy · Scalability Plan · Risks ·
Technical Debt Prevention

**External Integrations:** For every external service that issues more than one
credential (a base URL paired with an API key, an anon key + service key, a client
ID + secret, etc.), document those credentials as a single atomic group. Changing
one without the others is a recurring real-world failure mode — write down
explicitly which values must always be changed together and where each one lives
(which dashboard, which env var name in which deploy target).

---

## Phase 6: Repository Setup

Required dirs: `/docs /src /tests /scripts /.github`

Required files: `README.md · CHANGELOG.md · ROADMAP.md · TASKS.md ·
PROJECT_STATE.md · CLAUDE.md · GEMINI.md · ARCHITECT.md`

---

## Phase 7: Roadmap

**Deliverable:** `ROADMAP.md` — break the project into phases (e.g. Auth → Core
Features → Integrations → Optimization → Deployment).

---

## Phase 8: Task Generation

**Deliverable:** `TASKS.md`

Rules:
- Tasks must be small (< 4 hours) and independently testable.
- Tasks must have clear acceptance criteria.
- Every project's task list must include an explicit **Application Shell /
  Navigation** task, completed before or alongside the first one or two feature
  pages — not deferred. Individual page tasks can each pass their own acceptance
  criteria while the app as a whole remains unusable, because no task ever
  required a way to navigate between pages, sign out, or see where you are. The
  shell is its own task.
- Every task that renders a screen or component must cite the relevant section of
  `docs/ux-design.md` (or note that no wireframe exists yet, which blocks the task
  — go back to Phase 4.5 first). A UI task is not done until someone has actually
  looked at it rendered and compared it against that spec, not just passed
  type-check/lint/build.

---

## Phase 9: AI Agent Roles

- **Architect Agent** — System design, technical decisions, architecture reviews,
  risk analysis. Never writes implementation code.
- **Builder Agent** — Feature implementation, refactoring, testing, documentation.
  Must follow architecture.
- **Reviewer Agent** — Code/security/performance/maintainability review, plus
  **Design/UX review**: check the actual rendered screen against
  `docs/ux-design.md`, not against assumption. Verify color contrast is real,
  every empty state has a clear next action, every visible interactive-looking
  element is wired to a real handler/link (not a dead end), and the screen has
  navigation back to the rest of the app. Must reject shortcuts.

---

## Phase 10: Implementation Rules

Every implementation task must: read `architecture.md` · read `docs/ux-design.md`
(if it renders any screen/component) · read `requirements.md` · read
`PROJECT_STATE.md` · read the current task · verify dependencies · implement only
the requested scope · update tests · update documentation · update
`PROJECT_STATE.md`.

If the current execution environment lacks the access needed to verify or fix a
live issue (no network egress, no CLI, no real credentials), do not guess
repeatedly inside that constraint. Package the full diagnostic context — what's
confirmed, what's ruled out, exact next commands to run — and hand off to an
environment that actually has the access, rather than burning cycles re-deriving
the same dead end.

---

## Engineering Standards

- Max file size: **300 lines preferred.** Max function size: **50 lines preferred.**
- Use strict typing · avoid duplication · favor composition over inheritance ·
  follow SOLID · follow DRY · maintain separation of concerns.
- No hardcoded secrets · no dead code · no temporary hacks.
- **No silent failures** — including errors from third-party SDKs/libraries. Never
  let a caught error reach a user as an opaque object, a stringified `{}`, or a
  generic "something went wrong" with nothing logged server-side. Always log the
  full underlying error and surface a specific, diagnosable message, even if the
  user-facing copy stays friendly.
- Any function that runs under a different or elevated privilege context than the
  code calling it (SECURITY DEFINER functions, service-role connections, restricted
  DB roles, impersonation/service accounts) must not assume it inherits the
  caller's environment. Explicitly set its own search path / working context and
  fully-qualify any names it references. Don't rely on "it happened to work in dev."

---

## Testing Standards

Every feature requires: Unit Tests · Integration Tests (when applicable) · Error
Handling Tests · Edge Case Validation. No feature is complete without testing.

---

## Documentation Standards

Whenever architecture changes → update `architecture.md`. Whenever requirements
change → update `requirements.md`. Whenever project status changes → update
`PROJECT_STATE.md`. Documentation is not optional; it is part of development.

---

## PROJECT_STATE.md Format

Current Phase · Current Sprint · Completed · In Progress · Blocked · Next Tasks ·
Known Issues · Technical Debt · Last Updated.

---

## Pull Request Checklist

Before merging: Code reviewed · Tests passing · Documentation updated · No
duplicate logic · No architecture violations · No security issues · No linting
errors · No failing builds.

- **Manually walked through the live feature** in a real browser/app, not just
  reviewed in code — passing acceptance criteria on paper does not mean a human
  has confirmed it's actually usable.
- No invisible or low-contrast UI states (don't assume default component-library
  theme values are correct — verify).
- Every empty state has a clear call-to-action, not just an absence message.
- Matches `docs/ux-design.md`'s wireframe and empty/loading/error states for this
  screen — if `docs/ux-design.md` doesn't cover this screen, that's a blocker, not
  a detail to skip.

---

## Postmortem Process

After major milestones: What went well? · What failed? · What caused delays? ·
What should be automated? · What should become part of the template?

Every completed project improves the workflow. Every mistake becomes a future
guardrail.

---

## Master Rule

The objective is not to write code. The objective is to build maintainable systems
efficiently. **Code is the final step, not the first step.**
