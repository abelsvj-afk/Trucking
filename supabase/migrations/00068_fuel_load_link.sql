-- 00068 - Reliability Unit D (F-023, ruling D-02): a fuel purchase may be assigned to
-- ONE load. Nullable, no backfill: every existing purchase stays honestly unassigned
-- (it shows as "Fuel not assigned to a load" and is in no load's margin). The app
-- never assigns by date or truck proximity - assignment is the owner's act.
-- Same-company-ness is enforced by the write path today (like every other FK) and by
-- Unit E's composite FKs when they land.

alter table fuel_purchases
  add column load_id uuid references loads (id);

create index fuel_purchases_load_idx
  on fuel_purchases (load_id)
  where load_id is not null and deleted_at is null;
