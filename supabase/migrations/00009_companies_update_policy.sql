-- Real gap found during Stage 5's security/RLS review: 00001's own
-- comment documented "no update policy on companies" as intentional,
-- correct at the time (no client action needed one yet). Stage 4's
-- ai-settings work (docs/api-contracts.md's PATCH /api/v1/ai-settings,
-- src/app/api/v1/ai-settings/route.ts) introduced the first real need -
-- the owner's global AI kill switch (companies.ai_globally_disabled,
-- docs/schemas.md) is written through the normal authenticated session,
-- same anon-key + RLS path as everything else. Without this policy, that
-- write would be silently blocked by RLS (0 rows affected, not an error
-- the client would necessarily surface clearly) - the switch would look
-- like it saved but never actually take effect.
--
-- Row-level, not column-level: Postgres RLS doesn't restrict which
-- columns an UPDATE can touch, only which rows. The API layer is the only
-- sanctioned write path and only ever sends ai_globally_disabled - same
-- model already used by every other single-owner-writable table in this
-- app (e.g. industry_briefings' dismiss policy).

create policy "update own company" on companies
  for update using (id = current_company_id())
  with check (id = current_company_id());
