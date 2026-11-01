-- Agent omnipresence (docs/design/driver-mvp.md §9). Dump intake:
-- when the bot extracts several records from one dumped message,
-- each extracted item is stored as its own bot_pending_actions row
-- (the §8 proposal machinery, unchanged) and the rows share these
-- batch columns so the owner can approve the batch as a whole,
-- approve items by their stable number, correct one item, or drop
-- the rest. All nullable: a plain §8 single proposal leaves them
-- null and behaves exactly as before. The bot's store reads these
-- columns with a graceful fallback, so §8 behavior survives even
-- before this migration is applied; batching activates once the
-- columns exist.

alter table bot_pending_actions
  add column batch_id uuid,
  add column item_number integer,
  add column source_quote text,
  add column confidence text;

alter table bot_pending_actions
  add constraint bot_pending_actions_confidence_valid
  check (confidence is null or confidence in ('high', 'medium', 'low'));
