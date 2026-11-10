-- 00087: Business Credit (owner order 2026-11-10;
-- docs/design/business-credit.md).
--
-- Three pieces:
--   * page_access_rules - the owner-only page mechanism as DATA: which
--     route prefixes are owner-only. One seeded row flags the Business
--     Credit page; flagging another page later is a data edit, never a
--     code change. Deployment configuration, not tenant data: RLS on
--     with NO client policies (the server reads it through the session
--     client; nothing edits it from a browser session).
--   * business_credit_profiles / business_credit_accounts - the
--     company's credit file as data: the identity header (legal name,
--     D-U-N-S, Sunbiz doc, address, business email) and one row per
--     tracked vendor account. There is deliberately NO EIN column -
--     the brief forbids displaying one and none was provided.
--     payment_state / next_due_date / amount_due_cents start at
--     'none'/NULL/NULL for every vendor: nothing is owed until mail or
--     the owner says so; the UI never shows a fake date.
--   * business_credit_events - the audit trail for the email watch and
--     Abel's updates: every change records its source (email_watch /
--     abel_tool / owner), the signal, and the email_messages row that
--     caused it. buzz_state tracks the Telegram buzz ('none' = none
--     needed, 'held' = waiting out the delivery gate, 'sent').
--
-- Same posture as 00078/00084/00086: RLS on, one "tenant isolation"
-- policy per tenant table via private.current_company_id(), composite
-- (company_id, id) uniques so cross-table references are tenant-safe,
-- anon writes 0 by the 00067 defaults.
--
-- Seeds state the brief's verified facts (2026-11-10) for every
-- company that has none yet - they are this company's public business
-- facts, entered per company the same way the first pay profile was
-- live data (00063's precedent). The eCredable row is seeded PARKED
-- by the owner's standing order (subscribe Friday 2026-11-13): no code
-- path in this build activates any subscription, and the app never
-- places the Quill order - the $112.06 cart stays a note.

-- ---------------------------------------------------------------------------
-- Owner-only page rules (deployment configuration)
-- ---------------------------------------------------------------------------

create table if not exists public.page_access_rules (
  route_prefix text primary key,
  owner_only boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);

alter table public.page_access_rules enable row level security;
-- No policies: service-role/server reads only. Table grants follow the
-- platform defaults (as 00086's posture); nothing client-side reads it.

insert into public.page_access_rules (route_prefix, owner_only, note)
values (
  '/more/business-credit',
  true,
  'Business Credit page: the company credit file is owner-only business (brief 2026-11-10).'
)
on conflict (route_prefix) do nothing;

-- ---------------------------------------------------------------------------
-- Identity header - one row per company
-- ---------------------------------------------------------------------------

create table if not exists public.business_credit_profiles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  legal_name text not null,
  filed_name text,
  duns text,
  sunbiz_doc text,
  sunbiz_status text,
  registered_address text,
  business_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (company_id, id)
);

create unique index if not exists business_credit_profiles_company_uidx
  on public.business_credit_profiles (company_id) where deleted_at is null;

alter table public.business_credit_profiles enable row level security;

drop policy if exists "tenant isolation" on public.business_credit_profiles;
create policy "tenant isolation" on public.business_credit_profiles
  for all
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- ---------------------------------------------------------------------------
-- Tracked accounts - one row per vendor
-- ---------------------------------------------------------------------------

create table if not exists public.business_credit_accounts (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  vendor text not null,
  vendor_key text not null,
  status text not null,
  reports_to text[] not null default '{}',
  next_action text,
  payment_state text not null default 'none'
    check (payment_state in ('none', 'invoice_open', 'due_soon', 'paid', 'missed')),
  next_due_date date,
  amount_due_cents bigint,
  match_senders text[] not null default '{}',
  notes text,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (company_id, id),
  unique (company_id, vendor_key)
);

create index if not exists business_credit_accounts_company_idx
  on public.business_credit_accounts (company_id) where deleted_at is null;

alter table public.business_credit_accounts enable row level security;

drop policy if exists "tenant isolation" on public.business_credit_accounts;
create policy "tenant isolation" on public.business_credit_accounts
  for all
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- ---------------------------------------------------------------------------
-- Audit trail - what changed, from what signal, from which email
-- ---------------------------------------------------------------------------

create table if not exists public.business_credit_events (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  account_id uuid not null,
  source text not null check (source in ('email_watch', 'abel_tool', 'owner')),
  signal text not null check (signal in ('invoice', 'due_date', 'payment_made', 'missed', 'update')),
  email_message_id uuid,
  email_server_message_id text,
  summary text not null,
  detail jsonb not null default '{}'::jsonb,
  buzz_state text not null default 'none' check (buzz_state in ('none', 'held', 'sent')),
  buzz_text text,
  buzz_sent_at timestamptz,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (company_id, id),
  constraint business_credit_events_account_fk
    foreign key (company_id, account_id)
    references public.business_credit_accounts (company_id, id) on delete cascade,
  constraint business_credit_events_email_fk
    foreign key (company_id, email_message_id)
    references public.email_messages (company_id, id) on delete set null
);

-- One watch event per (account, email) - a message is never re-buzzed.
create unique index if not exists business_credit_events_watch_uidx
  on public.business_credit_events (company_id, account_id, email_message_id)
  where email_message_id is not null;

create index if not exists business_credit_events_company_created_idx
  on public.business_credit_events (company_id, created_at desc) where deleted_at is null;

alter table public.business_credit_events enable row level security;

drop policy if exists "tenant isolation" on public.business_credit_events;
create policy "tenant isolation" on public.business_credit_events
  for all
  using (company_id = (select private.current_company_id()))
  with check (company_id = (select private.current_company_id()));

-- ---------------------------------------------------------------------------
-- Seeds (brief 2026-11-10, verified facts) - per company without any yet
-- ---------------------------------------------------------------------------

insert into public.business_credit_profiles
  (company_id, legal_name, filed_name, duns, sunbiz_doc, sunbiz_status, registered_address, business_email)
select c.id,
       'SAJACOUS MIXED IT LLC',
       'SAJACOUSMIXEDIT LLC',
       '144-350783',
       'L26000135400',
       'ACTIVE',
       '720 N US Highway 441 #1021, Lady Lake, FL 32159',
       'owner@roadtolegacytrucking.com'
from public.companies c
where not exists (
  select 1 from public.business_credit_profiles p where p.company_id = c.id
);

insert into public.business_credit_accounts
  (company_id, vendor, vendor_key, status, reports_to, next_action, match_senders, notes, sort_order)
select c.id, v.vendor, v.vendor_key, v.status, v.reports_to, v.next_action, v.match_senders, v.notes, v.sort_order
from public.companies c
cross join (values
  ('Dun & Bradstreet', 'dun-and-bradstreet',
   'Established — free myD&B account live',
   array['Dun & Bradstreet'],
   'Baseline file is open; vendor trade lines (Quill first) build the score from here.',
   array['dnb.com'],
   'Login is owner@roadtolegacytrucking.com. The D-U-N-S number was revealed on the myD&B dashboard 2026-11-10.',
   1),
  ('Quill', 'quill',
   'Account established — Trade Exchange reporting on; net-30 denied 2026-11-10',
   array['Dun & Bradstreet'],
   'Place prepaid orders (invoices over $50 report to D&B through Trade Exchange); reapply for net-30 after about 90 days of prepaid history.',
   array['quill.com'],
   'A $112.06 prepaid cart (desk + office supplies) is saved and UNPLACED — the app never orders; purchase waits for the owner''s explicit buy word. Rule: only spend where it reports.',
   2),
  ('Uline', 'uline',
   'In progress — signup blocked by Uline''s bot check',
   array['Dun & Bradstreet', 'Experian'],
   'Register by phone at 1-800-295-5510 (their "Invoice Me" net-30 application), or the owner signs up himself.',
   array['uline.com'],
   'Reports to D&B and Experian once the account is active.',
   3),
  ('eCredable Business Lift', 'ecredable',
   'Profile complete — subscription PARKED until Friday 2026-11-13 (owner order)',
   array['Dun & Bradstreet', 'Experian', 'Equifax'],
   'Owner subscribes Friday 2026-11-13 ($19.95/mo); then switch the account email to owner@roadtolegacytrucking.com. Nothing activates it before then.',
   array['ecredable.com'],
   'Utilities, rent and service bills report as tradelines once subscribed. Equifax and Creditsafe are already linked to the profile in the background.',
   4),
  ('Nav', 'nav',
   'Free tier — monitoring only',
   array[]::text[],
   'No action. Free monitoring builds nothing by itself.',
   array['nav.com'],
   null,
   5),
  ('Bluevine', 'bluevine',
   'Business checking open',
   array[]::text[],
   'No action — the business checking account the LLC runs through.',
   array['bluevine.com'],
   'Approved on the EIN at signup; no credit tradeline reporting.',
   6)
) as v (vendor, vendor_key, status, reports_to, next_action, match_senders, notes, sort_order)
where not exists (
  select 1 from public.business_credit_accounts a where a.company_id = c.id
);
