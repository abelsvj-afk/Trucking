-- 00073 - Background tracking (docs/design/background-tracking.md, Path 2; owner on Android,
-- 2026-11-06). A native shell keeps reporting the truck's position with the app closed; it cannot
-- use the browser session cookie, so it authenticates with a DEVICE TOKEN:
--   * long-lived, revocable, scope-limited (it can only post position fixes);
--   * only its SHA-256 hash is stored - the secret is shown once when issued;
--   * tenant-isolated like every table (RLS), and revocation is a timestamp, never a delete.
-- driver_positions.source also gains 'device' (the position feed's own row, beside 'telegram').

create table device_tokens (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references companies (id),
  label text not null check (length(btrim(label)) > 0),
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

alter table device_tokens enable row level security;

create policy "tenant isolation" on device_tokens
  for all using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());

alter table driver_positions
  drop constraint if exists driver_positions_source_valid;
alter table driver_positions
  add constraint driver_positions_source_valid check (source in ('telegram', 'device'));
