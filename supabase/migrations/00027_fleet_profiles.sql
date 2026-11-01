-- UI/UX upgrade (docs/design/ui-ux.md, "UI/UX upgrade" section). The
-- fleet-profile fields the owner asked for on 2026-10-31: a truck TYPE
-- (sleeper, day cab, box truck - today there is nowhere to record what
-- kind of truck a truck is), a PHOTO for trucks/drivers/trailers (the
-- document row the photo lives in - the file itself rides the existing
-- documents storage pipeline, related_entity_type truck/driver/trailer),
-- and the rest of a real driver profile (phone, role, CDL expiry - the
-- drivers table previously held only a name, a CDL number, and a truck
-- assignment). Column adds only: no new table, so tenant RLS on all
-- three tables is unchanged. Everything nullable - existing rows keep
-- working untouched, and nothing here invents a value for a truck or
-- driver nobody has described yet.

alter table trucks
  add column truck_type text,
  add column photo_document_id uuid references documents (id);

alter table drivers
  add column phone text,
  add column role text,
  add column cdl_expires_on date,
  add column photo_document_id uuid references documents (id);

alter table trailers
  add column photo_document_id uuid references documents (id);
