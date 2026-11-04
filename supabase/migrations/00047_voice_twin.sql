-- Abel Intelligence Upgrade, Phase E — voice intake + driver
-- twin foundations (design Trucking-Abel-Intelligence-Upgrade-
-- Design-2026-11-02 §6/§7 Phase E). Numbered 00047 (renumbered in the union fix round; originally 00046): main tops at
-- 00041, the image/maintenance lane takes 00042-00044, Phase D
-- took 00045, Phase C took 00046. Independent of all of them.
--
-- Two additions:
-- 1. dispatch_exchanges gains the twin's measurement columns:
--    edit_distance_ratio (normalized Levenshtein distance between
--    Abel's draft and what the owner ACTUALLY sent, computed in
--    code at capture time - 0 = sent the draft untouched, 1 =
--    rewrote it entirely) and reply_captured_at. The trend of this
--    number IS the twin's report card: falling = the drafts are
--    learning his voice; rising gets surfaced, not hidden.
-- 2. load_decisions: the decision log - loads he took or passed,
--    with outcomes - the queryable pattern source for "what do I
--    usually do when...?" (design §6). Rows are his calls, stated
--    by him or captured from his threads; Abel never logs a
--    decision he didn't make.

alter table dispatch_exchanges
  add column edit_distance_ratio numeric,
  add column reply_captured_at timestamptz;

create table load_decisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  /** The load the decision was about, when it is a recorded load. */
  load_id uuid references loads (id),
  /** What the load was, in his words / the offer's own label ("Memphis load, $1,900, 700 mi"). */
  description text not null,
  decision text not null check (decision in ('taken', 'passed')),
  /** What happened afterwards, when known ("paid on time", "sat 3h at the dock"). */
  outcome_note text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index load_decisions_company_idx
  on load_decisions (company_id, created_at desc)
  where deleted_at is null;

alter table load_decisions enable row level security;

create policy "tenant isolation" on load_decisions
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
