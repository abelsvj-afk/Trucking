-- 00059 - Paper-log review save (docs/design/driver-hud.md §6). One
-- atomic call that turns a reviewed paper sheet into duty rows:
--   1. refuses unless the sheet is this company's (RLS + explicit check);
--   2. refuses if any app/other-sheet row starts inside the day and was
--      not explicitly acknowledged for replacement (paper-wins is the
--      driver's choice, never silent);
--   3. validates the rows: first starts at the day's 00:00, strictly
--      ascending, all inside the day;
--   4. soft-deletes (recoverable) this sheet's previous rows and the
--      acknowledged rows, inserts the new rows (source 'paper_photo'),
--      and retires any Telegram proposal batch for the same sheet so the
--      day can never be booked twice.
-- All of it commits or none of it does - a half-saved day would be a
-- falsified log. SECURITY INVOKER: every statement runs under the
-- caller's RLS. Numbering: next after 00058 (live layer).

create or replace function public.save_paper_log_day(
  p_document_id uuid,
  p_day_start timestamptz,
  p_day_end timestamptz,
  p_rows jsonb,
  p_replace_ids uuid[],
  p_notes text
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_company uuid := private.current_company_id();
  v_unacknowledged integer;
  v_prev timestamptz := null;
  v_row jsonb;
  v_at timestamptz;
  v_inserted integer;
begin
  if v_company is null then
    raise exception 'no company for this session' using errcode = '42501';
  end if;

  perform 1 from documents
   where id = p_document_id and company_id = v_company and deleted_at is null;
  if not found then
    raise exception 'paper log sheet not found' using errcode = 'P0002';
  end if;

  if p_day_end <= p_day_start or p_day_end - p_day_start > interval '25 hours' then
    raise exception 'invalid day bounds' using errcode = '22023';
  end if;

  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'no rows to save' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_at := (v_row->>'started_at')::timestamptz;
    if v_at < p_day_start or v_at >= p_day_end then
      raise exception 'row outside the day' using errcode = '22023';
    end if;
    if v_prev is null and v_at <> p_day_start then
      raise exception 'the day must start at 00:00' using errcode = '22023';
    end if;
    if v_prev is not null and v_at <= v_prev then
      raise exception 'rows must be strictly ascending' using errcode = '22023';
    end if;
    v_prev := v_at;
  end loop;

  select count(*) into v_unacknowledged
    from duty_logs
   where company_id = v_company
     and deleted_at is null
     and started_at >= p_day_start and started_at < p_day_end
     and source_document_id is distinct from p_document_id
     and not (id = any (coalesce(p_replace_ids, '{}')));
  if v_unacknowledged > 0 then
    raise exception 'existing entries in this day were not acknowledged'
      using errcode = 'P0001', hint = 'paper_log_conflict';
  end if;

  update duty_logs
     set deleted_at = now(), updated_at = now()
   where company_id = v_company
     and deleted_at is null
     and (
       source_document_id = p_document_id
       or (id = any (coalesce(p_replace_ids, '{}'))
           and started_at >= p_day_start and started_at < p_day_end)
     );

  insert into duty_logs (company_id, duty_status, started_at, source, source_document_id, notes)
  select v_company, r->>'duty_status', (r->>'started_at')::timestamptz, 'paper_photo', p_document_id, p_notes
    from jsonb_array_elements(p_rows) as r;
  get diagnostics v_inserted = row_count;

  update bot_pending_actions
     set deleted_at = now(), updated_at = now()
   where company_id = v_company
     and deleted_at is null
     and batch_id in (
       select batch_id from bot_pending_actions
        where company_id = v_company
          and deleted_at is null
          and batch_id is not null
          and arguments->>'source_document_id' = p_document_id::text
     );

  return v_inserted;
end;
$$;

revoke all on function public.save_paper_log_day(uuid, timestamptz, timestamptz, jsonb, uuid[], text) from public;
grant execute on function public.save_paper_log_day(uuid, timestamptz, timestamptz, jsonb, uuid[], text) to authenticated;
