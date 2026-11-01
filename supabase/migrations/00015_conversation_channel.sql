-- Bot intelligence v2 (docs/design/driver-mvp.md §8). telegram_messages
-- becomes the SHARED conversation store for both bot surfaces
-- (Telegram and the in-app web chat): one timeline per company, each
-- row tagged with the channel it came through. The table keeps its
-- name (renaming would churn every v1 reference for no gain); the
-- channel column is what makes "same brain, two windows" structural
-- rather than a promise. chat_id is Telegram-only provenance, so it
-- stops being required - web rows have no Telegram chat.

alter table telegram_messages
  add column channel text not null default 'telegram';

alter table telegram_messages
  add constraint telegram_messages_channel_valid
  check (channel in ('telegram', 'web'));

alter table telegram_messages
  alter column chat_id drop not null;

create index telegram_messages_company_created_idx
  on telegram_messages (company_id, created_at);
