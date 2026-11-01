-- Abel Job Brain (docs/design/driver-mvp.md §11). People & business
-- learning stores two new kinds of bot memory: "person_profile"
-- (a structured profile of someone the owner works with - the truck
-- owner, a dispatcher, a broker, a shipper) and "business_fact"
-- (how his operation actually runs - how this carrier pays, a
-- facility's quirk). Both live in the existing bot_memories table;
-- the only change is widening its kind check to admit them. No new
-- table, no column changes, RLS untouched - tenant isolation is the
-- table's existing policy. Until this migration is applied, saves of
-- the new kinds fail loudly at the constraint (the bot reports the
-- failure instead of silently dropping a profile).

alter table bot_memories
  drop constraint bot_memories_kind_valid;

alter table bot_memories
  add constraint bot_memories_kind_valid
  check (kind in (
    'fact', 'note', 'expense_hint', 'instruction',
    'person_profile', 'business_fact'
  ));
