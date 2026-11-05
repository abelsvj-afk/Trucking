-- 00070 - Reliability Unit E (F-036, ruling D-03): tenant integrity at the database
-- boundary. Every single-column foreign key between two tenant tables becomes a
-- COMPOSITE foreign key (company_id, child_fk) -> parent (company_id, id), so the
-- database itself refuses a row that points at another company's record - even for a
-- role that bypasses RLS. RLS policies are NOT touched.
--
-- GENERATED from the schema's own foreign-key catalog (63 relationships between tenant
-- tables on the scratch build at 00069); tests/db/tenant-fk-inventory.sql regenerates the
-- inventory and fails if any single-column tenant FK is left unconverted or a new one
-- appears (completeness check, design E.3 step 0/E.5 #5).
-- Not converted, with reasons: every `company_id -> companies(id)` (the tenant key itself),
-- and `user_profiles.id -> auth.users(id)` (Supabase-owned table, no company_id).
-- ON DELETE / ON UPDATE actions are preserved verbatim (all were NO ACTION).
--
-- PRE-FLIGHT (design E.3.1): the first block counts rows whose child company_id differs from
-- the parent's. ANY hit aborts the migration with the relationship names and counts - no
-- automatic repair, no nulling, no reassignment; the next step is an owner ruling.
-- Reported by relationship and count only (no row values).

do $$
declare
  hits text := '';
  n bigint;
begin

  select count(*) into n from bot_memories c join bot_memories p on p.id = c.superseded_by where c.superseded_by is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'bot_memories.superseded_by -> bot_memories: ' || n || ' row(s); '; end if;

  select count(*) into n from broker_followups c join brokers p on p.id = c.broker_id where c.broker_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'broker_followups.broker_id -> brokers: ' || n || ' row(s); '; end if;

  select count(*) into n from credentials c join documents p on p.id = c.document_id where c.document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'credentials.document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from credentials c join drivers p on p.id = c.driver_id where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'credentials.driver_id -> drivers: ' || n || ' row(s); '; end if;

  select count(*) into n from credentials c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'credentials.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from detention_stamps c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'detention_stamps.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from dispatch_exchanges c join brokers p on p.id = c.broker_id where c.broker_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'dispatch_exchanges.broker_id -> brokers: ' || n || ' row(s); '; end if;

  select count(*) into n from dispatch_exchanges c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'dispatch_exchanges.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from drivers c join trailers p on p.id = c.assigned_trailer_id where c.assigned_trailer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'drivers.assigned_trailer_id -> trailers: ' || n || ' row(s); '; end if;

  select count(*) into n from drivers c join trucks p on p.id = c.assigned_truck_id where c.assigned_truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'drivers.assigned_truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from drivers c join documents p on p.id = c.photo_document_id where c.photo_document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'drivers.photo_document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from duty_logs c join drivers p on p.id = c.driver_id where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'duty_logs.driver_id -> drivers: ' || n || ' row(s); '; end if;

  select count(*) into n from duty_logs c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'duty_logs.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from duty_logs c join documents p on p.id = c.source_document_id where c.source_document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'duty_logs.source_document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from equipment_checklist_items c join trailers p on p.id = c.trailer_id where c.trailer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'equipment_checklist_items.trailer_id -> trailers: ' || n || ' row(s); '; end if;

  select count(*) into n from equipment_checklist_items c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'equipment_checklist_items.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from expenses c join drivers p on p.id = c.driver_id where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'expenses.driver_id -> drivers: ' || n || ' row(s); '; end if;

  select count(*) into n from expenses c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'expenses.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from expenses c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'expenses.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from forward_thread_messages c join forward_threads p on p.id = c.thread_id where c.thread_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'forward_thread_messages.thread_id -> forward_threads: ' || n || ' row(s); '; end if;

  select count(*) into n from forward_threads c join dispatch_exchanges p on p.id = c.last_exchange_id where c.last_exchange_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'forward_threads.last_exchange_id -> dispatch_exchanges: ' || n || ' row(s); '; end if;

  select count(*) into n from fuel_purchases c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'fuel_purchases.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from fuel_purchases c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'fuel_purchases.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from fund_entries c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'fund_entries.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from game_checkpoints c join game_targets p on p.id = c.target_id where c.target_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'game_checkpoints.target_id -> game_targets: ' || n || ' row(s); '; end if;

  select count(*) into n from game_plan_runs c join game_plans p on p.id = c.plan_id where c.plan_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'game_plan_runs.plan_id -> game_plans: ' || n || ' row(s); '; end if;

  select count(*) into n from game_plan_runs c join game_targets p on p.id = c.target_id where c.target_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'game_plan_runs.target_id -> game_targets: ' || n || ' row(s); '; end if;

  select count(*) into n from game_plans c join game_targets p on p.id = c.target_id where c.target_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'game_plans.target_id -> game_targets: ' || n || ' row(s); '; end if;

  select count(*) into n from industry_briefing_runs c join industry_briefings p on p.id = c.briefing_id where c.briefing_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'industry_briefing_runs.briefing_id -> industry_briefings: ' || n || ' row(s); '; end if;

  select count(*) into n from load_decisions c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'load_decisions.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from load_invoices c join brokers p on p.id = c.broker_id where c.broker_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'load_invoices.broker_id -> brokers: ' || n || ' row(s); '; end if;

  select count(*) into n from load_invoices c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'load_invoices.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from load_stops c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'load_stops.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from load_tasks c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'load_tasks.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join brokers p on p.id = c.broker_id where c.broker_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.broker_id -> brokers: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join customers p on p.id = c.customer_id where c.customer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.customer_id -> customers: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join facilities p on p.id = c.delivery_facility_id where c.delivery_facility_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.delivery_facility_id -> facilities: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join drivers p on p.id = c.driver_id where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.driver_id -> drivers: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join facilities p on p.id = c.pickup_facility_id where c.pickup_facility_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.pickup_facility_id -> facilities: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join trailers p on p.id = c.trailer_id where c.trailer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.trailer_id -> trailers: ' || n || ' row(s); '; end if;

  select count(*) into n from loads c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'loads.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from maintenance_events c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'maintenance_events.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from maintenance_schedules c join trailers p on p.id = c.trailer_id where c.trailer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'maintenance_schedules.trailer_id -> trailers: ' || n || ' row(s); '; end if;

  select count(*) into n from maintenance_schedules c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'maintenance_schedules.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from pretrip_inspections c join drivers p on p.id = c.driver_id where c.driver_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'pretrip_inspections.driver_id -> drivers: ' || n || ' row(s); '; end if;

  select count(*) into n from pretrip_inspections c join trailers p on p.id = c.trailer_id where c.trailer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'pretrip_inspections.trailer_id -> trailers: ' || n || ' row(s); '; end if;

  select count(*) into n from pretrip_inspections c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'pretrip_inspections.truck_id -> trucks: ' || n || ' row(s); '; end if;

  select count(*) into n from research_briefings c join research_runs p on p.id = c.run_id where c.run_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'research_briefings.run_id -> research_runs: ' || n || ' row(s); '; end if;

  select count(*) into n from research_corridor c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'research_corridor.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from research_requests c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'research_requests.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from research_runs c join research_briefings p on p.id = c.briefing_id where c.briefing_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'research_runs.briefing_id -> research_briefings: ' || n || ' row(s); '; end if;

  select count(*) into n from settlement_lines c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'settlement_lines.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from settlement_lines c join settlements p on p.id = c.settlement_id where c.settlement_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'settlement_lines.settlement_id -> settlements: ' || n || ' row(s); '; end if;

  select count(*) into n from settlement_load_links c join loads p on p.id = c.load_id where c.load_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'settlement_load_links.load_id -> loads: ' || n || ' row(s); '; end if;

  select count(*) into n from settlement_load_links c join settlements p on p.id = c.settlement_id where c.settlement_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'settlement_load_links.settlement_id -> settlements: ' || n || ' row(s); '; end if;

  select count(*) into n from settlements c join documents p on p.id = c.source_document_id where c.source_document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'settlements.source_document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from trailers c join documents p on p.id = c.photo_document_id where c.photo_document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'trailers.photo_document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from trucks c join documents p on p.id = c.photo_document_id where c.photo_document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'trucks.photo_document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from vehicle_defects c join maintenance_events p on p.id = c.maintenance_event_id where c.maintenance_event_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'vehicle_defects.maintenance_event_id -> maintenance_events: ' || n || ' row(s); '; end if;

  select count(*) into n from vehicle_defects c join documents p on p.id = c.source_document_id where c.source_document_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'vehicle_defects.source_document_id -> documents: ' || n || ' row(s); '; end if;

  select count(*) into n from vehicle_defects c join pretrip_inspections p on p.id = c.source_inspection_id where c.source_inspection_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'vehicle_defects.source_inspection_id -> pretrip_inspections: ' || n || ' row(s); '; end if;

  select count(*) into n from vehicle_defects c join trailers p on p.id = c.trailer_id where c.trailer_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'vehicle_defects.trailer_id -> trailers: ' || n || ' row(s); '; end if;

  select count(*) into n from vehicle_defects c join trucks p on p.id = c.truck_id where c.truck_id is not null and c.company_id <> p.company_id;
  if n > 0 then hits := hits || 'vehicle_defects.truck_id -> trucks: ' || n || ' row(s); '; end if;

  if hits <> '' then
    raise exception 'tenant-integrity pre-flight FAILED - cross-company references exist: %. Migration paused for an owner ruling (no automatic repair).', hits;
  end if;
end $$;

-- Parents need UNIQUE (company_id, id) for a composite FK to reference.

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'bot_memories'::regclass and conname = 'bot_memories_company_id_id_key') then
    alter table bot_memories add constraint bot_memories_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'brokers'::regclass and conname = 'brokers_company_id_id_key') then
    alter table brokers add constraint brokers_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'customers'::regclass and conname = 'customers_company_id_id_key') then
    alter table customers add constraint customers_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'dispatch_exchanges'::regclass and conname = 'dispatch_exchanges_company_id_id_key') then
    alter table dispatch_exchanges add constraint dispatch_exchanges_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'documents'::regclass and conname = 'documents_company_id_id_key') then
    alter table documents add constraint documents_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'drivers'::regclass and conname = 'drivers_company_id_id_key') then
    alter table drivers add constraint drivers_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'facilities'::regclass and conname = 'facilities_company_id_id_key') then
    alter table facilities add constraint facilities_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'forward_threads'::regclass and conname = 'forward_threads_company_id_id_key') then
    alter table forward_threads add constraint forward_threads_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'game_plans'::regclass and conname = 'game_plans_company_id_id_key') then
    alter table game_plans add constraint game_plans_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'game_targets'::regclass and conname = 'game_targets_company_id_id_key') then
    alter table game_targets add constraint game_targets_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'industry_briefings'::regclass and conname = 'industry_briefings_company_id_id_key') then
    alter table industry_briefings add constraint industry_briefings_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'loads'::regclass and conname = 'loads_company_id_id_key') then
    alter table loads add constraint loads_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'maintenance_events'::regclass and conname = 'maintenance_events_company_id_id_key') then
    alter table maintenance_events add constraint maintenance_events_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'pretrip_inspections'::regclass and conname = 'pretrip_inspections_company_id_id_key') then
    alter table pretrip_inspections add constraint pretrip_inspections_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'research_briefings'::regclass and conname = 'research_briefings_company_id_id_key') then
    alter table research_briefings add constraint research_briefings_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'research_runs'::regclass and conname = 'research_runs_company_id_id_key') then
    alter table research_runs add constraint research_runs_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'settlements'::regclass and conname = 'settlements_company_id_id_key') then
    alter table settlements add constraint settlements_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'trailers'::regclass and conname = 'trailers_company_id_id_key') then
    alter table trailers add constraint trailers_company_id_id_key unique (company_id, id);
  end if;
end $$;

do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'trucks'::regclass and conname = 'trucks_company_id_id_key') then
    alter table trucks add constraint trucks_company_id_id_key unique (company_id, id);
  end if;
end $$;


-- Composite foreign keys (added NOT VALID, then validated).

alter table bot_memories drop constraint bot_memories_superseded_by_fkey;
alter table bot_memories add constraint bot_memories_superseded_by_tenant_fkey
  foreign key (company_id, superseded_by) references bot_memories (company_id, id) not valid;
alter table bot_memories validate constraint bot_memories_superseded_by_tenant_fkey;

alter table broker_followups drop constraint broker_followups_broker_id_fkey;
alter table broker_followups add constraint broker_followups_broker_id_tenant_fkey
  foreign key (company_id, broker_id) references brokers (company_id, id) not valid;
alter table broker_followups validate constraint broker_followups_broker_id_tenant_fkey;

alter table credentials drop constraint credentials_document_id_fkey;
alter table credentials add constraint credentials_document_id_tenant_fkey
  foreign key (company_id, document_id) references documents (company_id, id) not valid;
alter table credentials validate constraint credentials_document_id_tenant_fkey;

alter table credentials drop constraint credentials_driver_id_fkey;
alter table credentials add constraint credentials_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table credentials validate constraint credentials_driver_id_tenant_fkey;

alter table credentials drop constraint credentials_truck_id_fkey;
alter table credentials add constraint credentials_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table credentials validate constraint credentials_truck_id_tenant_fkey;

alter table detention_stamps drop constraint detention_stamps_load_id_fkey;
alter table detention_stamps add constraint detention_stamps_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table detention_stamps validate constraint detention_stamps_load_id_tenant_fkey;

alter table dispatch_exchanges drop constraint dispatch_exchanges_broker_id_fkey;
alter table dispatch_exchanges add constraint dispatch_exchanges_broker_id_tenant_fkey
  foreign key (company_id, broker_id) references brokers (company_id, id) not valid;
alter table dispatch_exchanges validate constraint dispatch_exchanges_broker_id_tenant_fkey;

alter table dispatch_exchanges drop constraint dispatch_exchanges_load_id_fkey;
alter table dispatch_exchanges add constraint dispatch_exchanges_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table dispatch_exchanges validate constraint dispatch_exchanges_load_id_tenant_fkey;

alter table drivers drop constraint drivers_assigned_trailer_id_fkey;
alter table drivers add constraint drivers_assigned_trailer_id_tenant_fkey
  foreign key (company_id, assigned_trailer_id) references trailers (company_id, id) not valid;
alter table drivers validate constraint drivers_assigned_trailer_id_tenant_fkey;

alter table drivers drop constraint drivers_assigned_truck_id_fkey;
alter table drivers add constraint drivers_assigned_truck_id_tenant_fkey
  foreign key (company_id, assigned_truck_id) references trucks (company_id, id) not valid;
alter table drivers validate constraint drivers_assigned_truck_id_tenant_fkey;

alter table drivers drop constraint drivers_photo_document_id_fkey;
alter table drivers add constraint drivers_photo_document_id_tenant_fkey
  foreign key (company_id, photo_document_id) references documents (company_id, id) not valid;
alter table drivers validate constraint drivers_photo_document_id_tenant_fkey;

alter table duty_logs drop constraint duty_logs_driver_id_fkey;
alter table duty_logs add constraint duty_logs_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table duty_logs validate constraint duty_logs_driver_id_tenant_fkey;

alter table duty_logs drop constraint duty_logs_load_id_fkey;
alter table duty_logs add constraint duty_logs_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table duty_logs validate constraint duty_logs_load_id_tenant_fkey;

alter table duty_logs drop constraint duty_logs_source_document_id_fkey;
alter table duty_logs add constraint duty_logs_source_document_id_tenant_fkey
  foreign key (company_id, source_document_id) references documents (company_id, id) not valid;
alter table duty_logs validate constraint duty_logs_source_document_id_tenant_fkey;

alter table equipment_checklist_items drop constraint equipment_checklist_items_trailer_id_fkey;
alter table equipment_checklist_items add constraint equipment_checklist_items_trailer_id_tenant_fkey
  foreign key (company_id, trailer_id) references trailers (company_id, id) not valid;
alter table equipment_checklist_items validate constraint equipment_checklist_items_trailer_id_tenant_fkey;

alter table equipment_checklist_items drop constraint equipment_checklist_items_truck_id_fkey;
alter table equipment_checklist_items add constraint equipment_checklist_items_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table equipment_checklist_items validate constraint equipment_checklist_items_truck_id_tenant_fkey;

alter table expenses drop constraint expenses_driver_id_fkey;
alter table expenses add constraint expenses_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table expenses validate constraint expenses_driver_id_tenant_fkey;

alter table expenses drop constraint expenses_load_id_fkey;
alter table expenses add constraint expenses_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table expenses validate constraint expenses_load_id_tenant_fkey;

alter table expenses drop constraint expenses_truck_id_fkey;
alter table expenses add constraint expenses_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table expenses validate constraint expenses_truck_id_tenant_fkey;

alter table forward_thread_messages drop constraint forward_thread_messages_thread_id_fkey;
alter table forward_thread_messages add constraint forward_thread_messages_thread_id_tenant_fkey
  foreign key (company_id, thread_id) references forward_threads (company_id, id) not valid;
alter table forward_thread_messages validate constraint forward_thread_messages_thread_id_tenant_fkey;

alter table forward_threads drop constraint forward_threads_last_exchange_id_fkey;
alter table forward_threads add constraint forward_threads_last_exchange_id_tenant_fkey
  foreign key (company_id, last_exchange_id) references dispatch_exchanges (company_id, id) not valid;
alter table forward_threads validate constraint forward_threads_last_exchange_id_tenant_fkey;

alter table fuel_purchases drop constraint fuel_purchases_load_id_fkey;
alter table fuel_purchases add constraint fuel_purchases_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table fuel_purchases validate constraint fuel_purchases_load_id_tenant_fkey;

alter table fuel_purchases drop constraint fuel_purchases_truck_id_fkey;
alter table fuel_purchases add constraint fuel_purchases_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table fuel_purchases validate constraint fuel_purchases_truck_id_tenant_fkey;

alter table fund_entries drop constraint fund_entries_load_id_fkey;
alter table fund_entries add constraint fund_entries_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table fund_entries validate constraint fund_entries_load_id_tenant_fkey;

alter table game_checkpoints drop constraint game_checkpoints_target_id_fkey;
alter table game_checkpoints add constraint game_checkpoints_target_id_tenant_fkey
  foreign key (company_id, target_id) references game_targets (company_id, id) not valid;
alter table game_checkpoints validate constraint game_checkpoints_target_id_tenant_fkey;

alter table game_plan_runs drop constraint game_plan_runs_plan_id_fkey;
alter table game_plan_runs add constraint game_plan_runs_plan_id_tenant_fkey
  foreign key (company_id, plan_id) references game_plans (company_id, id) not valid;
alter table game_plan_runs validate constraint game_plan_runs_plan_id_tenant_fkey;

alter table game_plan_runs drop constraint game_plan_runs_target_id_fkey;
alter table game_plan_runs add constraint game_plan_runs_target_id_tenant_fkey
  foreign key (company_id, target_id) references game_targets (company_id, id) not valid;
alter table game_plan_runs validate constraint game_plan_runs_target_id_tenant_fkey;

alter table game_plans drop constraint game_plans_target_id_fkey;
alter table game_plans add constraint game_plans_target_id_tenant_fkey
  foreign key (company_id, target_id) references game_targets (company_id, id) not valid;
alter table game_plans validate constraint game_plans_target_id_tenant_fkey;

alter table industry_briefing_runs drop constraint industry_briefing_runs_briefing_id_fkey;
alter table industry_briefing_runs add constraint industry_briefing_runs_briefing_id_tenant_fkey
  foreign key (company_id, briefing_id) references industry_briefings (company_id, id) not valid;
alter table industry_briefing_runs validate constraint industry_briefing_runs_briefing_id_tenant_fkey;

alter table load_decisions drop constraint load_decisions_load_id_fkey;
alter table load_decisions add constraint load_decisions_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table load_decisions validate constraint load_decisions_load_id_tenant_fkey;

alter table load_invoices drop constraint load_invoices_broker_id_fkey;
alter table load_invoices add constraint load_invoices_broker_id_tenant_fkey
  foreign key (company_id, broker_id) references brokers (company_id, id) not valid;
alter table load_invoices validate constraint load_invoices_broker_id_tenant_fkey;

alter table load_invoices drop constraint load_invoices_load_id_fkey;
alter table load_invoices add constraint load_invoices_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table load_invoices validate constraint load_invoices_load_id_tenant_fkey;

alter table load_stops drop constraint load_stops_load_id_fkey;
alter table load_stops add constraint load_stops_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table load_stops validate constraint load_stops_load_id_tenant_fkey;

alter table load_tasks drop constraint load_tasks_load_id_fkey;
alter table load_tasks add constraint load_tasks_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table load_tasks validate constraint load_tasks_load_id_tenant_fkey;

alter table loads drop constraint loads_broker_id_fkey;
alter table loads add constraint loads_broker_id_tenant_fkey
  foreign key (company_id, broker_id) references brokers (company_id, id) not valid;
alter table loads validate constraint loads_broker_id_tenant_fkey;

alter table loads drop constraint loads_customer_id_fkey;
alter table loads add constraint loads_customer_id_tenant_fkey
  foreign key (company_id, customer_id) references customers (company_id, id) not valid;
alter table loads validate constraint loads_customer_id_tenant_fkey;

alter table loads drop constraint loads_delivery_facility_id_fkey;
alter table loads add constraint loads_delivery_facility_id_tenant_fkey
  foreign key (company_id, delivery_facility_id) references facilities (company_id, id) not valid;
alter table loads validate constraint loads_delivery_facility_id_tenant_fkey;

alter table loads drop constraint loads_driver_id_fkey;
alter table loads add constraint loads_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table loads validate constraint loads_driver_id_tenant_fkey;

alter table loads drop constraint loads_pickup_facility_id_fkey;
alter table loads add constraint loads_pickup_facility_id_tenant_fkey
  foreign key (company_id, pickup_facility_id) references facilities (company_id, id) not valid;
alter table loads validate constraint loads_pickup_facility_id_tenant_fkey;

alter table loads drop constraint loads_trailer_id_fkey;
alter table loads add constraint loads_trailer_id_tenant_fkey
  foreign key (company_id, trailer_id) references trailers (company_id, id) not valid;
alter table loads validate constraint loads_trailer_id_tenant_fkey;

alter table loads drop constraint loads_truck_id_fkey;
alter table loads add constraint loads_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table loads validate constraint loads_truck_id_tenant_fkey;

alter table maintenance_events drop constraint maintenance_events_truck_id_fkey;
alter table maintenance_events add constraint maintenance_events_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table maintenance_events validate constraint maintenance_events_truck_id_tenant_fkey;

alter table maintenance_schedules drop constraint maintenance_schedules_trailer_id_fkey;
alter table maintenance_schedules add constraint maintenance_schedules_trailer_id_tenant_fkey
  foreign key (company_id, trailer_id) references trailers (company_id, id) not valid;
alter table maintenance_schedules validate constraint maintenance_schedules_trailer_id_tenant_fkey;

alter table maintenance_schedules drop constraint maintenance_schedules_truck_id_fkey;
alter table maintenance_schedules add constraint maintenance_schedules_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table maintenance_schedules validate constraint maintenance_schedules_truck_id_tenant_fkey;

alter table pretrip_inspections drop constraint pretrip_inspections_driver_id_fkey;
alter table pretrip_inspections add constraint pretrip_inspections_driver_id_tenant_fkey
  foreign key (company_id, driver_id) references drivers (company_id, id) not valid;
alter table pretrip_inspections validate constraint pretrip_inspections_driver_id_tenant_fkey;

alter table pretrip_inspections drop constraint pretrip_inspections_trailer_id_fkey;
alter table pretrip_inspections add constraint pretrip_inspections_trailer_id_tenant_fkey
  foreign key (company_id, trailer_id) references trailers (company_id, id) not valid;
alter table pretrip_inspections validate constraint pretrip_inspections_trailer_id_tenant_fkey;

alter table pretrip_inspections drop constraint pretrip_inspections_truck_id_fkey;
alter table pretrip_inspections add constraint pretrip_inspections_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table pretrip_inspections validate constraint pretrip_inspections_truck_id_tenant_fkey;

alter table research_briefings drop constraint research_briefings_run_id_fkey;
alter table research_briefings add constraint research_briefings_run_id_tenant_fkey
  foreign key (company_id, run_id) references research_runs (company_id, id) not valid;
alter table research_briefings validate constraint research_briefings_run_id_tenant_fkey;

alter table research_corridor drop constraint research_corridor_load_id_fkey;
alter table research_corridor add constraint research_corridor_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table research_corridor validate constraint research_corridor_load_id_tenant_fkey;

alter table research_requests drop constraint research_requests_load_id_fkey;
alter table research_requests add constraint research_requests_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table research_requests validate constraint research_requests_load_id_tenant_fkey;

alter table research_runs drop constraint research_runs_briefing_id_fk;
alter table research_runs add constraint research_runs_briefing_id_tenant_fkey
  foreign key (company_id, briefing_id) references research_briefings (company_id, id) not valid;
alter table research_runs validate constraint research_runs_briefing_id_tenant_fkey;

alter table settlement_lines drop constraint settlement_lines_load_id_fkey;
alter table settlement_lines add constraint settlement_lines_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table settlement_lines validate constraint settlement_lines_load_id_tenant_fkey;

alter table settlement_lines drop constraint settlement_lines_settlement_id_fkey;
alter table settlement_lines add constraint settlement_lines_settlement_id_tenant_fkey
  foreign key (company_id, settlement_id) references settlements (company_id, id) not valid;
alter table settlement_lines validate constraint settlement_lines_settlement_id_tenant_fkey;

alter table settlement_load_links drop constraint settlement_load_links_load_id_fkey;
alter table settlement_load_links add constraint settlement_load_links_load_id_tenant_fkey
  foreign key (company_id, load_id) references loads (company_id, id) not valid;
alter table settlement_load_links validate constraint settlement_load_links_load_id_tenant_fkey;

alter table settlement_load_links drop constraint settlement_load_links_settlement_id_fkey;
alter table settlement_load_links add constraint settlement_load_links_settlement_id_tenant_fkey
  foreign key (company_id, settlement_id) references settlements (company_id, id) not valid;
alter table settlement_load_links validate constraint settlement_load_links_settlement_id_tenant_fkey;

alter table settlements drop constraint settlements_source_document_id_fkey;
alter table settlements add constraint settlements_source_document_id_tenant_fkey
  foreign key (company_id, source_document_id) references documents (company_id, id) not valid;
alter table settlements validate constraint settlements_source_document_id_tenant_fkey;

alter table trailers drop constraint trailers_photo_document_id_fkey;
alter table trailers add constraint trailers_photo_document_id_tenant_fkey
  foreign key (company_id, photo_document_id) references documents (company_id, id) not valid;
alter table trailers validate constraint trailers_photo_document_id_tenant_fkey;

alter table trucks drop constraint trucks_photo_document_id_fkey;
alter table trucks add constraint trucks_photo_document_id_tenant_fkey
  foreign key (company_id, photo_document_id) references documents (company_id, id) not valid;
alter table trucks validate constraint trucks_photo_document_id_tenant_fkey;

alter table vehicle_defects drop constraint vehicle_defects_maintenance_event_id_fkey;
alter table vehicle_defects add constraint vehicle_defects_maintenance_event_id_tenant_fkey
  foreign key (company_id, maintenance_event_id) references maintenance_events (company_id, id) not valid;
alter table vehicle_defects validate constraint vehicle_defects_maintenance_event_id_tenant_fkey;

alter table vehicle_defects drop constraint vehicle_defects_source_document_id_fkey;
alter table vehicle_defects add constraint vehicle_defects_source_document_id_tenant_fkey
  foreign key (company_id, source_document_id) references documents (company_id, id) not valid;
alter table vehicle_defects validate constraint vehicle_defects_source_document_id_tenant_fkey;

alter table vehicle_defects drop constraint vehicle_defects_source_inspection_id_fkey;
alter table vehicle_defects add constraint vehicle_defects_source_inspection_id_tenant_fkey
  foreign key (company_id, source_inspection_id) references pretrip_inspections (company_id, id) not valid;
alter table vehicle_defects validate constraint vehicle_defects_source_inspection_id_tenant_fkey;

alter table vehicle_defects drop constraint vehicle_defects_trailer_id_fkey;
alter table vehicle_defects add constraint vehicle_defects_trailer_id_tenant_fkey
  foreign key (company_id, trailer_id) references trailers (company_id, id) not valid;
alter table vehicle_defects validate constraint vehicle_defects_trailer_id_tenant_fkey;

alter table vehicle_defects drop constraint vehicle_defects_truck_id_fkey;
alter table vehicle_defects add constraint vehicle_defects_truck_id_tenant_fkey
  foreign key (company_id, truck_id) references trucks (company_id, id) not valid;
alter table vehicle_defects validate constraint vehicle_defects_truck_id_tenant_fkey;
