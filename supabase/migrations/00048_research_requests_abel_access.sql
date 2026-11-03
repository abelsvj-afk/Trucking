-- 00048: R-6 (Research Intelligence design D-5/D-7) - Abel's
-- conversational access to research_requests.
--
-- Migration 00040 created research_requests with a SELECT policy
-- for company members and grants for the scoped job role - enough
-- for the research engine's own writes, but Abel runs on the web
-- surface through the owner's session, and with no INSERT/UPDATE
-- policy an owner session cannot queue or dismiss an ask at all
-- (the Telegram surface's service-role client bypasses RLS, the web
-- surface's does not - the bot must behave identically on both).
--
-- The two policies below mirror migration 00019's fences exactly:
-- an owner session may ONLY queue a pre-trip photo ask for its own
-- company (kind and starting status pinned, same shape the manual
-- research-run fence pins trigger_kind/status), and may ONLY update
-- its own company's requests (dismissing an ask). Fulfilment stays
-- with the job role / service role - no policy here lets a session
-- forge a fulfilled row's stamp; the update fence matches 00019's
-- briefing read/dismiss policy shape.

create policy "queue a pre-trip photo request for own company" on research_requests
  for insert with check (
    company_id = private.current_company_id()
    and kind = 'pretrip_photo'
    and status = 'queued'
  );

create policy "dismiss own company's research requests" on research_requests
  for update using (company_id = private.current_company_id())
  with check (company_id = private.current_company_id());
