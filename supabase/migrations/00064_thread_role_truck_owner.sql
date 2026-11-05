-- 00064 - Thread roles name a ROLE, never a person (owner ruling 2026-11-05).
-- Threads recorded before this used a named-person value as the role of the
-- truck owner. Rewrite stored values to the generic role "truck_owner"; the
-- person's NAME stays untouched on the participant (it is the owner's real
-- data, and who the truck owner is lives there and in his people records).
-- Idempotent: running it again changes nothing.

update forward_threads t
set participants = (
  select coalesce(jsonb_agg(
    case when lower(p ->> 'role') = 'steven'
         then jsonb_set(p, '{role}', '"truck_owner"')
         else p end
  ), '[]'::jsonb)
  from jsonb_array_elements(t.participants) p
)
where exists (
  select 1 from jsonb_array_elements(t.participants) p where lower(p ->> 'role') = 'steven'
);

update forward_thread_messages
set sender_role = 'truck_owner'
where lower(sender_role) = 'steven';
