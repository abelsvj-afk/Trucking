-- 00066 - Trailer assignment (owner request 2026-11-05: "assign the truck and
-- trailer to yourself"). Trucks were already assignable (drivers.
-- assigned_truck_id, loads.truck_id); trailers were not.
--   * drivers.assigned_trailer_id - the trailer a driver normally pulls;
--   * loads.trailer_id            - the trailer on this trip.
-- Both nullable, both reference trailers. No data change; photos already live
-- on trailers.photo_document_id (migration 00027).

alter table drivers
  add column assigned_trailer_id uuid references trailers (id);

alter table loads
  add column trailer_id uuid references trailers (id);
