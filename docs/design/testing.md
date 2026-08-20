# Testing Strategy

Phase 7 deliverable per `MASTER AI ENGINEERING & SYSTEM DEVELOPMENT WORKFLOW`. Testing is part of implementation, not an optional final step — this defines what gets tested and how before any test (or feature) code is written.

## Unit tests

Target the pieces with real logic to get wrong: business-rule validation (`docs/design/data-model.md` — date ordering, non-negative amounts, draft-exclusion from financial totals), and any pure computation (e.g. the financial-summary aggregation math). `services/db`, `services/auth`, and `services/api` (per `docs/architecture.md`) are the natural unit boundaries — each testable without a real database or network call.

## Integration tests

Run against a real (test/local) Postgres instance, not mocks — the thing most worth verifying here is behavior the database itself enforces:

- **Row-level security actually isolates tenants.** This is the single most important integration test in the system: create two companies, confirm company A's session can never read or write company B's rows, for every table. A passing test suite that skips this would be missing the one bug class that matters most given `docs/design/security.md`'s threat model.
- Every API route in `docs/api-contracts.md` round-trips correctly (create → read → update → soft-delete → excluded from list).
- Validation rejects bad input with the documented error shape, not a 500 or a silent partial write.

## End-to-end tests

Drive the actual UI (`docs/design/ui-ux.md`) in a browser, covering the workflows in `docs/user-stories.md`: create a load (normal), save an incomplete load (alternative/draft), trigger a validation error (error), upload a document, view the financial summary. These are the tests that actually catch "the backend works but nothing is reachable from the UI" — the exact failure `CLAUDE.md`'s no-backend-only rule exists to prevent.

## Error handling & edge cases

- Soft-deleted records: excluded from list/financial-summary queries, `404` on direct lookup by id (per `docs/api-contracts.md`).
- Draft loads: excluded from the financial summary even if they have a `rate_cents` value set.
- A failed save doesn't lose the form's in-progress data (per `docs/design/ui-ux.md`'s States section) — test that a simulated network failure leaves the entered values intact.
- Concurrent edits: last-write-wins is accepted as correct at MVP scale, not a bug — there is exactly one user (per `docs/governance.md`'s access model), so this is a deliberate simplification, not something to build conflict resolution for yet.

## Security tests

- The RLS isolation test above (the most important test in the suite).
- Every route rejects an unauthenticated request with `401` before touching business logic.
- Injection attempts against text fields fail safely (parameterized queries only, per `docs/design/security.md` — no raw SQL string-building to test against in the first place, but verify anyway).
- File upload rejects disallowed types/oversized files before they reach storage.

## Performance tests

Not a priority yet. `docs/architecture.md` already decided against caching and against a high-concurrency target at MVP scale (one user, growing to a small fleet) — building a performance test suite for a load profile that doesn't exist would be testing a hypothetical. Revisit if real usage ever shows an actual slow path.

## AI evaluation

Not applicable yet. No AI capability exists (Governance Level 1, per `docs/governance.md`); an evaluation strategy gets defined alongside the AI capability itself in Phase 9 (Intelligence Design), not speculated here.

---

*Test coverage should track what's actually built — this document sets the strategy, not a checklist to pad before there's code to test.*
