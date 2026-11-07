-- 00076 - How the owner answers Abel's proposals (docs/design/bot-messages-and-safety.md section 6, owner approved
-- 2026-11-07). One row per proposal fate: approved, dropped, corrected, expired, failed, or replaced by a newer
-- proposal. It is the raw material for Abel learning from his answers: per-signature approval statistics computed in
-- code, lessons he approves one by one, and a visible risk flag on suggestions he usually drops.
-- ADDITIVE, tenant-isolated like every table, soft-delete (deleted_at), no seed. Written best-effort by the bot: a
-- missing table or a failed write never affects a conversation.

create table bot_proposal_outcomes (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  tool_name text not null check (length(btrim(tool_name)) > 0),
  -- tool + category/kind (for example "create_expense/fuel"): what "a suggestion like this" means
  signature text not null check (length(btrim(signature)) > 0),
  outcome text not null
    constraint bot_proposal_outcomes_outcome_valid check (outcome in ('approved', 'dropped', 'corrected', 'expired', 'failed', 'replaced')),
  summary text not null,
  arguments jsonb,
  channel text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index bot_proposal_outcomes_company_signature
  on bot_proposal_outcomes (company_id, signature, created_at desc)
  where deleted_at is null;

alter table bot_proposal_outcomes enable row level security;

create policy "tenant isolation" on bot_proposal_outcomes
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
