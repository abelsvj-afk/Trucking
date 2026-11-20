-- Billing seat (Phase 2, branch feat/bot-billing-2026-11-19):
-- two proposal kinds for Billing's drafts. No new tables: the
-- receivable lifecycle already exists as load_invoices (migration
-- 00055), which Billing READS; invoice drafts live as bot_proposals
-- rows until an approved proposal is executed (Phase 1).
--
-- AUTHORED ONLY — NOT APPLIED. The live apply is the owner's tap,
-- via King's lane, before any deploy (same rule as 00103). Until
-- this lands, invoice-draft / factoring-packet proposals cannot be
-- written to the live table; the code paths fail loudly instead of
-- silently writing a kind the database would reject.

alter table bot_proposals
  drop constraint if exists bot_proposals_kind_check,
  add constraint bot_proposals_kind_check check (
    kind in ('load-draft', 'load-shortlist', 'message-draft', 'record-draft', 'call-plan', 'invoice-draft', 'factoring-packet', 'other')
  );
