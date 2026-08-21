# UI/UX Design

Phase 7 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. This is the real design work `CLAUDE.md`'s "no backend-only delivery" rule points to — screens, navigation, states, workflows, errors, and accessibility for the mandatory working frontend, over the entities in `docs/schemas.md` and the API in `docs/api-contracts.md`.

Designed for the actual context of use: one person, checking and entering data from a phone, often between loads or at a truck stop — not a desk-bound back-office user. Everything below follows from that.

## Navigation

A bottom tab bar, not a sidebar — sidebars are a desktop pattern that doesn't work well one-handed on a phone. Five tabs, each owning a cluster of the MVP entities so nothing requires more than two taps to reach:

| Tab | Contains |
|---|---|
| **Home** | Dashboard: financial summary snapshot, recent activity, quick-add shortcuts |
| **Loads** | Load list, load detail, new/edit load |
| **Fleet** | Trucks, trailers, drivers, maintenance events |
| **Money** | Expenses, fuel purchases, full financial summary |
| **More** | Customers, brokers, documents, account/settings (incl. the AI status + kill switches from `docs/governance.md`), industry intelligence |

Each tab's own sections (e.g. Fleet's Trucks/Trailers/Drivers/Maintenance) are reached via a simple segmented control at the top of that tab, not nested navigation — staying shallow matters more than looking sophisticated here.

## Screens

### Home (dashboard)
- Financial summary card for the current month (revenue, expenses, net) — pulled from `/api/v1/financial-summary`, tap to jump to Money for detail.
- "Recent activity" list: last few loads/expenses/fuel purchases entered, most recent first.
- Quick-add buttons for the things entered most often: new load, new expense, new fuel purchase.
- First-run empty state (see States) instead of a blank dashboard for a brand-new account.

### Loads
- List, most recent first, filterable by status (`draft` / `confirmed` / `completed`, matching `docs/schemas.md`). Draft loads carry a visible "Draft" badge so it's never ambiguous which loads are missing information.
- Load detail/edit: origin, destination, dates, rate, miles, truck, driver, broker/customer, notes, status. Saving with a missing rate or dates is allowed and keeps the load in `draft` — this is the deliberate "alternative workflow" from `docs/user-stories.md`, not an error state.
- New load: same form, empty, status defaulting to `draft`. The owner explicitly picks `confirmed`/`completed` when the load is actually settled — per `docs/design/data-model.md`, status is something "the owner" moves, not something the system infers from which fields happen to be filled in. Added while building task 5.2's e2e suite, which is what actually caught that no control for this existed anywhere: every load created through the app defaulted to `draft` forever, so the financial summary's `confirmed`/`completed` filter could never include anything.

### Fleet
- **Trucks / Trailers / Drivers:** list + detail. Truck detail shows current mileage/status plus its linked maintenance history and documents in place — no separate hunt required to see a truck's full picture.
- **Maintenance:** list of events (filterable by truck), add/edit form (description, cost, date, mileage at service).

### Money
- **Expenses** and **Fuel purchases:** list + add/edit forms, filterable by truck/date range.
- **Summary:** the full `/financial-summary` view with a date-range picker, not just the Home snapshot.

### More
- **Customers / Brokers:** list + detail (contact info, notes).
- **Documents:** browsed per related record (a truck, load, trailer, or driver) rather than one flat file list — matches how `docs/schemas.md` associates them, and matches how you'd actually look for a document ("the permit for Truck #1," not "file #482").
- **Account/Settings:** login/session management now. Once any AI capability exists (Governance Level 2+), this is also where the AI's current authorization level and the global + per-capability kill switches from `docs/governance.md` live — visible from the main navigation, not buried, per the requirement already locked into `docs/requirements.md`.
- **Industry intelligence:** a feed, most recent first, of dismissable cards — each showing `summary`/`reasoning`/`confidence`/`based_on` per the shared output contract (`docs/design/ai-architecture.md`), plus a `service_status` banner (per `docs/api-contracts.md`) that only appears when the consecutive-failure escalation has actually triggered, not on every visit. Lives under More since that's already where the rest of what's *about* the AI (its authorization state, the kill switches) lives — this is a feed *from* a capability, not a business record like Customers/Documents, so it gets its own entry rather than folding into either.

## Screens not yet designed

**The screens above are the MVP only — not the final set.** This document does not yet include, because each depends on a capability that hasn't had its own requirements/architecture pass yet (per `docs/requirements.md`'s "Future phases" and `docs/vision.md`'s "Future features"):

- **Fuel route** — an interactive map showing the optimized route/fuel stop, not just a number. You've been explicit this needs real visual treatment, not a data table; it gets designed once Fuel Intelligence has its own architecture (including picking a mapping/routing library, which is a real dependency decision per `CLAUDE.md`'s Dependency Rule).
- **Load recommendation ("take this load")** — the decision engine's approval-workflow card described under Workflows below, once that engine exists. A visual sketch of the card exists in Figma (see "Figma" below) — that's exploratory design work, not a spec, and doesn't substitute for the decision engine's own Requirements → Architecture pass before any code gets written against it.
- **Home-time planner**, **parking network map**, **load-board search/integration view**, and **advanced financial reporting** (trends, margin over time, fleet-expansion readiness) — each tied to its own future engine in `docs/vision.md`.

*(The industry intelligence briefing screen moved out of this list and into the More section above once Stage 4 actually designed and built it — this list is "not yet designed," not "designed but not linked here.")*

## Figma

A Figma file (["Trucking OS"](https://www.figma.com/design/2ADG0k1cQ2lZlf4TjAolhm)) exists alongside this document once the Figma MCP connector became available, per the "Visual design system" section's original note that nothing here was Figma-incompatible if that changed. It holds two things, kept deliberately separate:

- **A small component library bound to this document's real design tokens** (`Button/Primary`, `Button/Secondary`, `Button/Danger-Outline`, `Field/Text`, `Badge/Status`, `Badge/Confidence-High`) — Figma variables mirroring `src/app/globals.css`'s `@theme` values exactly (same hex codes, same 44px touch target, same 8px radius), not redrawn from memory. `Screen/Login` reassembles the real `/login` screen from these components as a check that the mapping holds — verified by screenshotting both side by side, not just by eye.
- **`Card/Load-Recommendation-Approval`** — a forward design for the Workflows section's "Approval (Level 2+ AI)" card above, sketched now so the shape exists before the decision engine's own spec work starts. Explicit Approve/Modify/Reject actions (never auto-applied, per `docs/governance.md`), reasoning shown in full, and a `based_on` line — matching the output contract's fields exactly (`docs/design/ai-architecture.md`). This is early design exploration, not itself a substitute for that engine's Requirements/Architecture phases — nothing here authorizes writing code against it yet.

None of these are being skipped — they're sequenced. Each shows up in this document once its own Requirements → Architecture → Detailed Design pass happens, the same path every MVP screen above already went through. If a screen you're expecting isn't in this list either, say so — this list should stay a complete map of "known future work," not just what happens to come up.

## States

Every list and form screen has four states, not just the "happy path":

- **Loading** — skeleton/placeholder content, not a blank screen, while a request is in flight.
- **Empty** — a real first-run message ("No loads yet — add your first one") with the quick-add action right there, not just an empty list.
- **Populated** — the normal case.
- **Error** — see Errors below; never a silent failure, per `CLAUDE.md`.

Forms specifically also track **unsaved changes**: if a save request fails (network drop, server error), the entered data stays in the form rather than being lost — the reliability requirement in `docs/requirements.md` ("data entered by the operator must not be silently lost") is a UI responsibility as much as a backend one. A failed save shows an inline retry, not a reset form.

## Workflows

Maps directly onto the workflows already defined in `docs/user-stories.md`:

- **Normal (e.g. recording a load):** fill form → save → confirmation toast → appears in the list immediately.
- **Alternative (incomplete load):** save with missing fields → stored as `draft`, visibly badged, excluded from the financial summary until completed.
- **Error (invalid entry):** inline, field-level messages at the moment of save (e.g. "Rate must be a positive number" directly under the rate field) — never a generic top-of-screen alert that doesn't say what's wrong.
- **Approval (future, Level 2+ AI):** a recommendation appears as its own card/state, with its reasoning shown, and explicit Approve/Modify/Reject actions — never auto-applied. Not built yet; this is the screen shape it will need to slot into.
- **Escalation (future):** same visual language as a validation error but framed as "needs your input" rather than "you made a mistake" — the system is saying it can't decide, not that the user did something wrong.
- **Recovery (save/sync failure):** a persistent, dismissible banner ("Couldn't save — retry") rather than a modal that blocks the rest of the app; the user can keep working elsewhere while it retries.

## Errors

- **Field-level validation errors** render inline, next to the field, sourced from the API's standard error response in `docs/api-contracts.md` — never a raw `error.code` shown to the user; codes map to a plain-language message.
- **Network/server errors** render as a banner distinguishing "your data is safe, we couldn't reach the server" from "something went wrong on our end" — the user should never have to guess whether re-entering data will duplicate it.
- **Never surfaced to the user:** stack traces, internal paths, raw exception text — matches the centralized error handling rule in `CLAUDE.md`. A generic message plus, only in a collapsed "details" affordance, the error code — useful for you to report a bug, invisible otherwise.

## Accessibility

`docs/requirements.md` left the accessibility standard open pending this phase. Decision: **WCAG 2.1 AA** as the baseline target — semantic HTML, labeled form fields, sufficient color contrast, keyboard/screen-reader operability. This is cheap to build in from the start (proper labels and semantic elements, not an afterthought pass) and expensive to retrofit later — the same reasoning already applied to `company_id` scoping and API versioning in `docs/architecture.md`. It also matters concretely for a system meant to become a product other people pay for.

## Visual design system

Decided now (Stage 6, once the app was actually visible and the owner asked for a real design pass) rather than at scaffolding time, per this document's original note that visual styling is an implementation-time choice. Built directly in Tailwind CSS v4's `@theme` tokens (`src/app/globals.css`) rather than via Figma-to-code — the Figma MCP connector was unavailable when this was done; nothing here is Figma-incompatible if that changes later.

**Tone:** a professional operations tool, not a consumer app — the owner is reading these screens between loads, often outdoors, often in a hurry. Clarity and contrast beat decoration.

- **Color:** a confident blue (`#2563eb`, "primary") for interactive elements — active nav tab, primary buttons, links — against a white/near-white surface with a gray neutral scale for structure and secondary text. Status uses the same semantic mapping already established informally in the data (`draft`/`active`/error): amber for draft/pending, green for active/success/confirmed, red for destructive actions and errors — never color alone (every status already carries a text label, per the accessibility work in task 3.12).
- **Typography:** the system font stack (`-apple-system`, Segoe UI, Roboto, etc.) — no web font download, which matters on the truck-stop wifi this app is actually used over, and it already looks native on every device.
- **Spacing/density:** comfortable tap targets (44px minimum touch target, matching platform guidance) over a dense desktop-style layout — every list row, button, and form field sized for a thumb, not a mouse.
- **Styling mechanism:** every screen already uses plain semantic HTML consistently (`<form>`, `<label>`, `<input>`, `<select>`, `<button>`, `<ul>`/`<li>`) — chosen for accessibility in task 3.12, not incidentally. Rather than introduce a component library on top of that, the visual design is applied as base-element styles in `src/app/globals.css` (Tailwind v4's `@layer base`), so every form/list/button across all ~40 screens picks up the same look automatically. This is the same "shared infra, not per-screen reinvention" approach already used for `services/db/crud.ts` and `ListStates.tsx`, just expressed as CSS instead of a JS component — a screen's visual language comes from the semantic element it already uses, not from hand-tuned utility classes scattered per file.
- **Navigation:** the bottom tab bar gets a real visual treatment — elevated surface, active-tab color + icon-weight distinction (not just the underlying `aria-current` that already exists for accessibility).

---

*Visual styling (colors, typography, exact component library) isn't decided here — that's an implementation-time choice within the structure above, not a separate spec step. What's fixed by this document is structure, states, and behavior; polish is free to evolve.*
