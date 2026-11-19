-- Bot-team job claims (Phase 2; branch feat/bot-maintenance-2026-11-19).
-- Postgres job claiming: single-writer ownership per thread/job, so
-- two deliveries of the same Telegram update (or two workers) can
-- never run the same workup twice. One open claim per job key: the
-- primary key (company_id, job_key) is the lock, and expires_at is
-- the TTL — a stale claim (worker died mid-workup) is taken over by
-- the next claim attempt after it expires (default 5 minutes in
-- code). The claim is the IN-FLIGHT guard only: the proposal row's
-- source_ref stays the durable idempotency record, so even a claim
-- lost to a race cannot file the same defect twice.
--
-- RLS by company_id, like every bot-team table in 00103. Writes go
-- through the service-role client only (bots + webhook); there are
-- deliberately no authenticated insert/update/delete policies here.
--
-- This migration is AUTHORED, NOT applied. The live apply is the
-- owner's tap, via King's lane, before any deploy that reads it.
-- Numbering: renumbered to 00107 at rebase onto main 56bfa91 —
-- 00105 was claimed by the Tracker / Billing / Compliance crews.
-- Nothing earlier is edited (migrations are frozen once applied).

create table if not exists bot_job_claims (
  company_id uuid not null references companies(id) on delete cascade,
  job_key text not null check (char_length(job_key) between 1 and 240),
  bot_slug text not null references bot_identities(slug) on delete cascade,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (company_id, job_key)
);
create index if not exists bot_job_claims_company_expiry_idx on bot_job_claims (company_id, expires_at);

alter table bot_job_claims enable row level security;

-- Company read for the app surfaces. Writes go through the
-- service-role client only (bots + webhook); there are deliberately no
-- authenticated insert/update/delete policies here.
create policy "bot_job_claims: company read" on bot_job_claims
  for select using (company_id = current_company_id());
