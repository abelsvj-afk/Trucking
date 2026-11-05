-- Reliability Unit E acceptance (design E.5 #4): the documents polymorphic-reference trigger
-- (migration 00071). Run as a privileged role; one transaction; rolls back.
--   (a) nonexistent target  (b) another company's load  (c) soft-deleted own load  -> rejected,
--       and the three errors are BYTE-IDENTICAL (message and SQLSTATE): the non-oracle property.
--   (d) a live own load -> accepted. A disallowed type -> rejected. 'company' on itself -> accepted.
--   psql -d scratch -v ON_ERROR_STOP=1 -f tests/db/documents-trigger.sql

begin;

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000aa01';
  b uuid := '00000000-0000-0000-0000-00000000bb01';
  live_a uuid := gen_random_uuid();
  dead_a uuid := gen_random_uuid();
  load_b uuid := gen_random_uuid();
  m1 text; s1 text; m2 text; s2 text; m3 text; s3 text; m4 text; s4 text;
begin
  insert into companies (id, name) values (a, 'A'), (b, 'B');
  insert into loads (id, company_id, origin, destination) values (live_a, a, 'x', 'y'), (load_b, b, 'x', 'y');
  insert into loads (id, company_id, origin, destination, deleted_at) values (dead_a, a, 'x', 'y', now());

  begin insert into documents (company_id, related_entity_type, related_entity_id, file_name, storage_path) values (a, 'load', gen_random_uuid(), 'f', 'p');
  exception when others then get stacked diagnostics m1 = message_text, s1 = returned_sqlstate; end;
  begin insert into documents (company_id, related_entity_type, related_entity_id, file_name, storage_path) values (a, 'load', load_b, 'f', 'p');
  exception when others then get stacked diagnostics m2 = message_text, s2 = returned_sqlstate; end;
  begin insert into documents (company_id, related_entity_type, related_entity_id, file_name, storage_path) values (a, 'load', dead_a, 'f', 'p');
  exception when others then get stacked diagnostics m3 = message_text, s3 = returned_sqlstate; end;
  begin insert into documents (company_id, related_entity_type, related_entity_id, file_name, storage_path) values (a, 'spaceship', live_a, 'f', 'p');
  exception when others then get stacked diagnostics m4 = message_text, s4 = returned_sqlstate; end;

  if m1 is null or m2 is null or m3 is null or m4 is null then raise exception 'a bad reference was ACCEPTED'; end if;
  if not (m1 = m2 and m2 = m3 and m3 = m4 and s1 = s2 and s2 = s3 and s3 = s4) then
    raise exception 'rejections are distinguishable (oracle): [%/%] [%/%] [%/%] [%/%]', m1, s1, m2, s2, m3, s3, m4, s4;
  end if;

  insert into documents (company_id, related_entity_type, related_entity_id, file_name, storage_path) values (a, 'load', live_a, 'f', 'p');
  insert into documents (company_id, related_entity_type, related_entity_id, file_name, storage_path) values (a, 'company', a, 'f', 'p');

  -- re-pointing an existing document at another company's load is rejected too
  begin update documents set related_entity_type = 'load', related_entity_id = load_b where company_id = a and related_entity_type = 'load';
  exception when others then get stacked diagnostics m1 = message_text; end;
  if m1 is distinct from 'invalid document reference' then raise exception 'UPDATE to a foreign target was accepted'; end if;

  raise notice 'documents trigger: 4 bad references rejected with byte-identical errors (%, %); live own load and company self-reference accepted; update to foreign target rejected', m1, s1;
end $$;

rollback;
