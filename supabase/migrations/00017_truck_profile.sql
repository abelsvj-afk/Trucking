-- Smart Path v1 (docs/design/driver-mvp.md §8.2). The truck profile the
-- route check plans against: physical dimensions, running profile, and
-- the appliance inventory the food route is keyed to. All nullable /
-- defaulted-empty - nothing is seeded; the first real profile is
-- Steven's truck, captured by the owner on the first run. Column adds
-- only: no new table, so tenant RLS on trucks is unchanged.

alter table trucks
  add column height_in integer,
  add column length_in integer,
  add column weight_lbs integer,
  add column governed_speed_mph integer,
  add column tank_capacity_gallons numeric(6, 1),
  add column avg_mpg numeric(4, 1),
  add column appliances text[] not null default '{}',
  add column appliance_notes text;
