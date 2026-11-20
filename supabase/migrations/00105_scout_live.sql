-- Dispatch Scout goes live in the Telegram group (2026-11-19,
-- branch feat/scout-group-live-2026-11-19).
--
-- Scout's group replies now send from his own bot account
-- (@DispatchScoutBot; token in the TELEGRAM_DISPATCH_SCOUT_BOT_TOKEN
-- Fly secret, live since v115). bot_identities.status is bookkeeping
-- — no code gates on it — and this flip keeps the record true: Scout
-- is live in the group; the other planned bots are not.
update bot_identities
set status = 'live'
where slug = 'dispatch-scout' and status <> 'live';
