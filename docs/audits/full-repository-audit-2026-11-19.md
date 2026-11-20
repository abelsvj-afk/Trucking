# Full-Repository Audit — Road to Legacy Trucking

> **Status: AUDIT FINDINGS / NOT ACCEPTED / DESIGN REVIEW REQUIRED**
>
> **Prepared:** 2026-11-19  
> **Repository:** [abelsvj-afk/Trucking](https://github.com/abelsvj-afk/Trucking)  
> **Audit base:** `main` at `4bd5258971c20443284ff38b37cdd719bc587736`  
> **Audit branch:** `audit/full-repository-2026-11-19`  
> **Report path:** `docs/audits/full-repository-audit-2026-11-19.md`  
> **Purpose:** Give Claude / Muse a durable, traceable investigation backlog. This is not authorization to implement, merge, migrate, or deploy.

## 1. Executive summary

A broad source-level review identified security/tenant-isolation, dispatch/calling, driver-duty inference, GPS quality, financial accuracy, AI authorization, Android tracking, and operational reliability risks.

The findings below are a triage register, not a claim that every file, runtime path, or production configuration has been exhaustively tested. Several items are confirmed source patterns; others are conditional on live database grants, deployment topology, or require reproduction. The report deliberately preserves those distinctions.

**No application code was changed. No database migration was applied. No tests, typecheck, lint, build, device test, or live production verification was run as part of this audit handoff.** Do not treat an unexecuted test as passing.

## 2. Repository snapshot and limits

At the audited `main` baseline:

- Main commit: `4bd5258971c20443284ff38b37cdd719bc587736`.
- Approximately 2,029 tracked tree entries.
- 158 API route files.
- 480 test files.
- 94 SQL migration files; migration numbering reaches `00105` with gaps.
- 84 documentation files.
- No `.github/workflows` entries were present in the inspected tree. This is consistent with the owner's standing prohibition on GitHub Actions.

These counts are a repository snapshot, not a statement that all 2,029 entries were individually reviewed in depth. The audit did not establish that this commit is the deployed Fly release, nor inspect live Supabase grants/schema, production secrets, logs, or runtime behavior.

## 3. Severity guide

- **P0 — Critical:** immediate risk of severe compromise, safety impact, or irreversible loss; stop affected capability pending verification.
- **P1 — High:** material security, tenant isolation, safety, financial, or operational risk; prioritize before expanding the affected feature.
- **P2 — Medium:** meaningful correctness, resilience, or maintainability issue; schedule after P1 containment.
- **Needs verification:** a source-level concern whose exploitability or impact depends on live grants/configuration, a test run, or reproduction.

Severity is a triage recommendation, not a completed risk acceptance.

## 4. Findings register

### F-001 — SECURITY DEFINER outbound-call claim RPC may be callable too broadly
**Priority:** P1 — **Needs live privilege verification**  
**Location:** `supabase/migrations/00100_outbound_calls.sql`, function `claim_next_outbound_call`

The function appears to be SECURITY DEFINER without an explicit EXECUTE revocation or an explicit caller-company membership check. PostgreSQL grants EXECUTE on newly created functions to PUBLIC by default unless privileges are changed. If the deployed grants preserve that default and the RPC is exposed through Supabase, an unauthorized caller may be able to claim another company's queued call, read returned call metadata, or disrupt queue state. The function claims/updates a call row; this finding does **not** establish that it directly initiates a phone call.

The function also needs review for a pinned safe `search_path` and fully qualified object references.

**Verify:** query `has_function_privilege` for PUBLIC/anon/authenticated/service_role on the live database; inspect PostgREST exposure and function body; test cross-company access with two isolated tenants.  
**Remediation direction:** revoke broad EXECUTE, grant only to the intended server role, validate company membership/ownership inside the function, pin safe search_path, and add DB-level cross-tenant tests.

### F-002 — Business Credit owner-only access may not be enforced at the database boundary
**Priority:** P1 — **Needs live grants/policy verification**  
**Location:** `supabase/migrations/00087_business_credit.sql`, `src/app/api/v1/business-credit/route.ts`, `page-access.ts`

The application page/API appears to apply owner-oriented access controls, but company-scoped RLS is not equivalent to owner-only authorization. A company member with a valid Supabase session may be able to access the table directly through PostgREST if grants and policies permit it, bypassing the app route's page-access check.

**Verify:** inspect table grants and effective RLS policies on the deployed database; test owner, dispatcher, and driver roles using direct authenticated REST requests.  
**Remediation direction:** enforce the intended role at the database boundary or remove direct client access and route all access through a properly authorized server path.

### F-003 — Automatic Off Duty inference from inactivity can create false duty records
**Priority:** P1 — safety/compliance  
**Location:** `src/services/fleet/auto-motion.ts`, `src/lib/auto-motion-rules.ts`, `src/services/telegram/live-location.ts`

When the latest duty status is Driving, the automation can create Off Duty after a period (observed rule: two hours) of detected parking. The flow does not appear to require a previously unanswered driver prompt, affirmative driver confirmation, or proof that the driver is actually resting. User-facing wording may imply that the driver was asked even though the code does not verify an answer.

A parked truck, disconnected tracker, GPS gap, loading delay, breakdown, or other inactivity is not proof of Off Duty or Sleeper Berth.

**Remediation direction:** never infer a legally meaningful duty status solely from inactivity. Keep status unchanged and request explicit driver confirmation; preserve an audit trail and make corrections transparent.

### F-004 — Weekly recap may convert query failures/missing data into zero-valued financial results
**Priority:** P1/P2 — financial correctness  
**Location:** `src/services/bot/weekly-recap.ts`

Expense/fuel query errors or absent data may be treated as zero. Revenue calculations may also mix confirmed and completed load states. A recap can therefore look complete while omitting failed or unavailable inputs, or count loads under an inconsistent delivery definition.

**Remediation direction:** distinguish `$0` from unavailable/failed/not-yet-reconciled data; expose source coverage and query errors; define one canonical delivered/revenue status contract and test partial-failure scenarios.

### F-005 — Queued outbound calls may bypass the outbound/AI kill switches
**Priority:** P1  
**Location:** `src/app/api/telnyx/webhook/route.ts`, queue progression / `dialNextQueued()`

The initial `place_call` path checks global AI and outbound-call capability, but the queued-call progression path appears to check Telnyx credentials without rechecking those controls. A queued call may therefore proceed after outbound calling or global AI has been disabled.

**Remediation direction:** enforce kill switches at every transition that can initiate or continue a call, including queue sweeps, retries, and delayed work. A disabled state must fail closed.

### F-006 — Telnyx call lifecycle can retain orphan calls or accept stale terminal-state changes
**Priority:** P2  
**Location:** `src/app/api/telnyx/webhook/route.ts` and call lifecycle handlers

If Telnyx places a call but assistant startup fails, the application appears to mark the record failed without a compensating hangup. Late or duplicate webhooks may also overwrite a completed/terminal state.

**Remediation direction:** define an explicit state machine; make webhook processing idempotent; reject invalid transitions from terminal states; hang up or reconcile provider calls when startup fails; add periodic provider/application reconciliation.

### F-007 — Outbound-call driver relationship is not tenant-composite
**Priority:** P1/P2 — tenant integrity  
**Location:** `supabase/migrations/00100_outbound_calls.sql`

The outbound-call `driver_id` relationship appears to use a single-column foreign key instead of the established `(company_id, driver_id)` composite relationship. This can permit a row to reference a driver belonging to another company unless another constraint prevents it.

**Remediation direction:** use company-scoped composite foreign keys and add cross-tenant insert/update rejection tests.

### F-008 — Business Credit event email-message FK may null the tenant key on deletion
**Priority:** P2 — **Confirm exact deployed DDL**  
**Location:** `supabase/migrations/00087_business_credit.sql`

The event-to-email-message relationship appears to use composite `ON DELETE SET NULL` behavior. If the delete action applies to both columns in the composite key, it may attempt to null `company_id` as well as the optional message reference, conflicting with a non-null tenant key or weakening tenant integrity.

**Verify:** inspect the exact FK column list and PostgreSQL behavior on a disposable database; do not assume this is a production incident.  
**Remediation direction:** use a column-specific SET NULL action for the optional reference where supported, or redesign the relationship so the tenant key remains immutable.

### F-009 — Bot intent execution gate relies on broad keyword/regex matching
**Priority:** P2 — AI authorization correctness  
**Location:** `src/services/bot/execute-gate.ts`

The gate appears to use regex/keyword matching for write intent. Terms such as `miles`, `mark`, `complete`, or `delivered` may match benign questions or negated statements (for example, asking how many miles a load has, or saying a load has not been delivered). This weakens a safety layer, though it does not by itself prove a write occurs; model tool selection and other authorization checks still matter.

**Remediation direction:** use structured intent classification with explicit target/action confirmation, test negation and question cases, and keep authorization independent from natural-language matching. Add focused unit tests for the gate.

### F-010 — Tenant-FK regression test is important but was not executed
**Priority:** P1/P2 — validation gap  
**Location:** `tests/db/tenant-fk.sql`

The repository includes a dynamic tenant-FK check that should detect single-column relationships inconsistent with the company-scoped composite-FK standard. It is expected to flag some relationships noted in this report, but the SQL test was not run during this audit.

**Remediation direction:** execute against a disposable database built from all migrations; record exact failing constraints; repair migrations with forward-only changes and rerun tenant-isolation tests.

### F-011 — Auto-motion rule can create Off Duty without explicit driver action
**Priority:** P1 — safety/compliance  
**Location:** `src/services/fleet/auto-motion.ts`, `src/lib/auto-motion-rules.ts`

This is the same underlying behavior as F-003, separated here because the implementation and acceptance tests should explicitly cover the rules engine as well as the service integration. The two-hour parked condition must not be interpreted as proof of a rest period.

**Remediation direction:** track driver acknowledgement as a required event; do not silently write a duty status from motion data.

### F-012 — Missing GPS accuracy is treated as perfect/acceptable accuracy
**Priority:** P1/P2 — location correctness  
**Location:** `src/lib/live-motion.ts`

The accuracy guard appears to use a default of zero when `accuracyM` is missing (for example, `(cur.accuracyM ?? 0) > MAX_ACCURACY_M`). Missing accuracy is therefore accepted rather than treated as unknown. Motion speed derived from low-quality or incomplete samples can be trusted when it should be rejected or marked uncertain.

**Remediation direction:** represent missing accuracy as unknown; require a valid accuracy field before using a fix for movement/duty inference; distinguish rejected, stale, and uncertain samples.

### F-013 — Device-feed rate limiting is process-local
**Priority:** P2 — distributed reliability  
**Location:** `src/services/fleet/device-feed.ts`

The rate limiter uses an in-memory Map. Limits are independent across Fly machines and reset on process restart, so it is not a global per-device or per-company limit in a multi-instance deployment.

**Remediation direction:** use a shared atomic limiter (for example, a database/Redis-backed counter) or explicitly document and constrain the deployment to one instance; test concurrency and restart behavior.

### F-014 — New tenant relationships in migrations 00097/00099/00100 are not company-composite
**Priority:** P1/P2 — tenant integrity  
**Location:** migrations `00097`, `00099`, `00100`

Paycheck-confirmation-to-document, monthly-income-goal-to-driver, and outbound-call-to-driver relationships appear to use single-column FKs despite the established company-scoped composite-FK pattern (introduced/used elsewhere, including migration `00070`, with a later repair in `00090`). The existing tenant-FK test is intended to detect this class of defect.

**Remediation direction:** enforce matching `company_id` on every tenant-owned relationship; test cross-company references in both insert and update paths.

### F-015 — Bot write-intent gate can false-positive on ordinary language
**Priority:** P2 — AI authorization correctness  
**Location:** `src/services/bot/execute-gate.ts`

The `update_load` and `complete_load` keyword sets include broad terms such as `miles` and `delivered`. Questions, explanations, and negations may satisfy the regex gate. There was no dedicated execute-gate unit test identified in the inspected test coverage.

**Remediation direction:** add test matrices for questions, negation, quoted text, unrelated context, and explicit commands; avoid using regex match as sufficient authorization.

### F-016 — Queue sweeper does not consistently re-evaluate calling kill switches
**Priority:** P1  
**Location:** `src/app/api/telnyx/webhook/route.ts`

This duplicates the core risk in F-005 from the scheduled/queued progression perspective. The control must be checked immediately before each provider dial, not only when the original request is accepted.

**Remediation direction:** centralize a fail-closed `canInitiateOutboundCall` decision and call it from every entry point.

### F-017 — Call startup failure and late webhooks lack robust compensation/state protection
**Priority:** P2  
**Location:** `src/app/api/telnyx/webhook/route.ts`

This duplicates F-006 from the provider callback perspective. A failed assistant startup needs provider-side cleanup; late or repeated events must not resurrect or rewrite terminal call state.

**Remediation direction:** event idempotency keys, monotonic state transitions, compensating hangup, and reconciliation tests.

### F-018 — Android tracker backup may include bearer device credentials
**Priority:** P2 — credential exposure  
**Location:** `native/tracker/android/app/src/main/AndroidManifest.xml` and tracker preferences

The manifest sets `android:allowBackup="true"`. The Android tracker stores a bearer device token in preferences. No corresponding backup exclusion was identified in the reviewed files. If those preferences are included in Android backup/transfer, a device credential may be copied beyond the intended device boundary.

**Verify:** inspect backup/data-extraction rules and the exact preference storage path for the current app build.  
**Remediation direction:** exclude credential-bearing preferences from backup/transfer or disable backup where appropriate; rotate/revoke device credentials on device loss.

### F-019 — Android tracker drops queued GPS batches on HTTP 400
**Priority:** P2 — data loss  
**Location:** `native/tracker/android/app/src/main/java/` tracker service (reviewed implementation: `TrackerService.java`)

The tracker appears to remove a queued batch after an HTTP 400 response. A batch-level schema or validation error can therefore permanently discard up to 60 fixes, even if some fixes were individually valid.

**Remediation direction:** preserve rejected batches for diagnosis/retry; distinguish permanent per-fix validation failures from request-level errors; surface a bounded dead-letter queue and explicit loss telemetry.

### F-020 — Device-feed rate limits reset per machine/restart
**Priority:** P2 — distributed reliability  
**Location:** `src/services/fleet/device-feed.ts`

Duplicate of F-013. Keep one canonical implementation ticket; retain this cross-reference so the Android/device-ingestion workstream does not miss the issue.

### F-021 — Android GPS producer and server quality contract disagree
**Priority:** P1/P2 — location correctness  
**Location:** Android tracker producer and `src/lib/live-motion.ts`

The Android tracker may submit fixes without accuracy and does not appear to wait for an adequately accurate fix before enqueueing. The server then treats missing accuracy as zero (F-012). Producer and consumer therefore disagree about what constitutes a trustworthy location sample.

**Remediation direction:** define a versioned location payload contract; include accuracy, timestamp, source, and validity; reject/mark unknown quality consistently on both ends.

### F-022 — Bot proposal decision route lacks explicit owner-role authorization
**Priority:** P1 — authorization  
**Location:** `src/app/api/bots/proposals/route.ts`

The POST route authenticates a session but did not show an explicit `ctx.auth.role === "owner"` check before allowing a proposal decision. It records `decidedBy: "owner"` as a hardcoded value. If a non-owner company member can reach this route, they may approve/deny proposals and the audit record may misattribute the actor.

**Remediation direction:** require owner role server-side before any decision write; derive actor identity/role from authenticated context; test owner, dispatcher, driver, and cross-company cases.

### F-023 — Bot-team monthly spend cap may fail open when the store is unavailable
**Priority:** P1/P2 — cost control  
**Location:** `src/services/bots/group.ts`, `src/services/bots/store.ts`

The monthly spend-cap check appears to occur only when the bot-team store is available. In reduced mode (for example, missing store configuration), the group may still proceed to a paid model call without enforcing the cap.

**Remediation direction:** fail closed for paid operations when the required budget ledger/cap cannot be read; define a safe reduced mode that does not silently bypass cost controls.

### F-024 — Bot-team spend cap has a concurrent-request race
**Priority:** P2 — cost control  
**Location:** `src/services/bots/group.ts`, `src/services/bots/spend.ts`

The flow appears to read the remaining cap, make a model call, and record spend afterward. Concurrent requests can both pass the same pre-call balance and collectively exceed the cap.

**Remediation direction:** atomically reserve budget before calling the model; settle actual cost afterward; release unused reservation; add concurrency tests.

### F-025 — Bot-team tables need stronger tenant-consistent foreign keys
**Priority:** P2 — tenant integrity  
**Location:** `supabase/migrations/00103_bot_team.sql`

The new bot-team schema appears to rely in some relationships on independent company and record identifiers rather than composite foreign keys that guarantee the related records belong to the same company. Company-level RLS alone does not guarantee relational consistency.

**Verify:** inspect each FK in the migration and compare it with the `company_id` of both parent and child rows.  
**Remediation direction:** add company-composite unique keys/FKs wherever both records are tenant-owned; test cross-company references and deletes.

## 5. De-duplication and tracking notes

Some register entries intentionally describe the same root defect from separate call sites or workstreams. Do not create duplicate implementation work:

- F-003 and F-011: one auto-Off-Duty inference defect.
- F-005 and F-016: one outbound kill-switch enforcement defect.
- F-006 and F-017: one call lifecycle/state-machine defect.
- F-009 and F-015: one regex intent-gate defect.
- F-012 and F-021: one GPS quality-contract defect across producer and consumer.
- F-013 and F-020: one process-local rate-limiter defect.

F-014 overlaps F-007 on the broader tenant-FK theme but covers multiple additional relationships. F-010 is the test/verification gap for those schema findings.

## 6. Priority order for investigation and containment

1. **Outbound RPC authorization (F-001):** verify live function privileges immediately; revoke broad access if confirmed.
2. **Business Credit database boundary (F-002):** verify effective grants/RLS with non-owner roles.
3. **Duty-status automation (F-003/F-011):** prevent inactivity alone from creating a legally meaningful Off Duty/Sleeper status.
4. **Outbound-call kill switch (F-005/F-016):** recheck before every dial/queue transition.
5. **Bot proposal authorization (F-022):** enforce owner role and truthful actor attribution.
6. **Tenant integrity (F-007/F-010/F-014/F-025):** run migration-based database tests and repair composite relationships.
7. **GPS quality (F-012/F-021):** treat missing accuracy as unknown; align Android and server contracts.
8. **Financial recap correctness (F-004):** distinguish zero from missing/failed data.
9. **Call lifecycle (F-006/F-017):** idempotency, terminal-state protection, provider cleanup.
10. **Bot cost controls (F-023/F-024):** fail closed and reserve budget atomically.
11. **Android tracker resilience/security (F-018/F-019):** protect credentials and preserve failed batches.
12. **AI execution intent (F-009/F-015):** replace/strengthen regex-only authorization and add tests.
13. **Distributed rate limiting (F-013/F-020):** shared limits across Fly instances.

## 7. Positive architecture worth preserving

The inspected bot-team direction has useful boundaries that should not be casually removed:

- Separate identities and per-bot memory.
- Explicit proposal records and owner decision history.
- Read-only load-board scanning by Scout; no direct load creation from Scout.
- Dedicated browser worker and human-paced reads.
- Stop-run interface and separate outcome/spend ledgers.
- Proposal approval does not itself execute the proposed action.

Preserve these guardrails while correcting the authorization, spend, and tenant-integrity gaps.

## 8. Required verification plan

Before any finding can be marked VERIFIED or CLOSED, the assigned investigator should provide reproducible evidence:

1. **Source confirmation:** exact current-main commit, file path, line range, call graph, and whether the finding still exists.
2. **Database verification:** build a disposable database from all migrations; run tenant-FK checks; inspect effective grants and RLS; include two-company negative tests.
3. **Automated tests:** add focused regression tests for every accepted defect; run the relevant test suites and record exact commands/results.
4. **Static gates:** run typecheck, lint, production build, and repository-required gates; report failures without relabeling pre-existing failures as new.
5. **Android:** test backup exclusions, credential lifecycle, poor-network behavior, HTTP 400/429/5xx, process death, and queue recovery on a real or representative device.
6. **Calling:** test kill-switch changes with queued calls, provider failures, duplicate/late webhooks, and startup failure/hangup compensation.
7. **Live verification:** separately verify the deployed Fly release and production Supabase schema/configuration. Source commit is not proof of deployment.
8. **Operational UX:** test phone-sized screens, one-handed operation, weak signal/offline recovery, daylight readability, and driver confirmation flows.

Every result must identify the commit, environment, command or scenario, and evidence. A source review alone cannot close runtime or production findings.

## 9. Instructions for Claude / Muse

This document is an investigation handoff, not implementation authorization.

**Roles and authority**
- **Owner / product authority:** Sajacous. Only the owner approves design, implementation, merge, and deployment.
- **ChatGPT:** architect, independent reviewer, and acceptance authority.
- **Claude / Muse:** investigators and implementation partners when explicitly authorized.

**Required workflow**
`NOT VERIFIED → VERIFIED → DESIGN REQUIRED → DESIGN APPROVED → IMPLEMENTATION → TESTING → CODE REVIEW → ACCEPTED → LIVE VERIFICATION → CLOSED`

For each finding:
1. Re-check it against current `main`; do not assume this audit branch is current.
2. Mark it **VERIFIED**, **NOT REPRODUCED**, or **NEEDS LIVE VERIFICATION**, with file/line evidence and test/reproduction steps.
3. Create a design proposal describing root cause, impact, minimal fix, alternatives, migration/rollback implications, test plan, and operational risks.
4. Stop and request owner approval before implementation.
5. Do not merge or deploy without a separate owner instruction.
6. Keep audit notes and proposed fixes isolated from production code until approval.

**Standing repository constraints**
- Do not add GitHub Actions or other GitHub workflow automation.
- Do not merge to `main`.
- Do not deploy to Fly or change production configuration.
- Do not apply migrations to production.
- Do not silently change product behavior, legal/HOS semantics, financial calculations, or AI authority boundaries.
- Preserve phone-first, one-handed, weak-signal usability.

## 10. Audit disposition

**Overall:** NOT ACCEPTED as a production-readiness sign-off. The report records material risks requiring verification and design review. No finding is considered closed by this document.

**Changes made by this audit handoff:** documentation only. The report is committed on a dedicated audit branch; application code, migrations, deployment, and production data were not changed.

**Next owner decision:** select which verified findings should move to design. Claude/Muse may investigate and prepare designs, but must not implement until the owner approves the specific design.
