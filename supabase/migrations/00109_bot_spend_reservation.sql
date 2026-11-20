-- Audit F-024 (verified 2026-11-20): the bot spend cap was check-then-call-
-- then-record, so two turns arriving together both saw room under the cap
-- and both called the paid model. This adds an ATOMIC reservation: one
-- function locks the company's ledger, sums the month, and inserts the
-- reservation only if it still fits. The model is called only after a
-- reservation succeeds; settle_bot_spend then replaces the reserved amount
-- with the real estimate. Additive; the ledger table (00103) is unchanged.
-- Service role only (the bots run server-side with it).

create or replace function public.reserve_bot_spend(
  p_company_id uuid,
  p_bot_slug text,
  p_model text,
  p_tier text,
  p_cents integer,
  p_cap_cents integer,
  p_since timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  spent integer;
  reserved uuid;
begin
  if p_cents < 0 or p_cap_cents < 0 then
    raise exception 'spend amounts must not be negative' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('bot-spend-' || p_company_id::text));
  select coalesce(sum(estimated_cents), 0) into spent
    from public.bot_spend_ledger
    where company_id = p_company_id and created_at >= p_since;
  if spent + p_cents > p_cap_cents then
    return null;
  end if;
  insert into public.bot_spend_ledger (company_id, bot_slug, model, tier, estimated_cents)
    values (p_company_id, p_bot_slug, p_model, p_tier, p_cents)
    returning id into reserved;
  return reserved;
end;
$$;

create or replace function public.settle_bot_spend(p_company_id uuid, p_id uuid, p_cents integer)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.bot_spend_ledger
    set estimated_cents = greatest(p_cents, 0)
    where id = p_id and company_id = p_company_id;
$$;

revoke execute on function public.reserve_bot_spend(uuid, text, text, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke execute on function public.settle_bot_spend(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_bot_spend(uuid, text, text, text, integer, integer, timestamptz) to service_role;
grant execute on function public.settle_bot_spend(uuid, uuid, integer) to service_role;
