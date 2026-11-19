-- Maintenance bot seat (Phase 2; branch feat/bot-maintenance-2026-11-19).
-- Wires the Maintenance identity row seeded by 00103 to its governing
-- file (docs/bots/maintenance/CLAUDE.md): status 'live' (wired in
-- code — NOT deployed; deploy is still the owner's separate tap) and
-- the tool scope the governing file grants.
--
-- Scope mapping (registry vocabulary):
--   loads "read", hos "none", money "read" (estimates, owner only),
--   documents "draft" (read + file records by truck; execute-class
--   sign/file stays impossible), email "draft" (draft a shop/vendor
--   message; sending is execute-class, needs an approved proposal,
--   no execution path yet), maps "read" (nearest shop, route to the
--   shop), app-actions "draft" (work-order drafts, PM reminders),
--   calls "gated" (shops/vendors, owner-approved call plan, shared
--   number +1 320-369-0102, logged), signature "never".
--
-- This migration is AUTHORED, NOT applied. The live apply is the
-- owner's tap, via King's lane, before any deploy that reads it.
-- Numbering: renumbered to 00106 at rebase onto main 56bfa91 —
-- 00104 is Malik's call-tools migration on main, and 00105 was
-- claimed by the Tracker / Billing / Compliance crews.
-- Nothing earlier is edited (migrations are frozen once applied).

update bot_identities
set status = 'live',
    tool_scope = '{"loads": "read", "hos": "none", "money": "read", "documents": "draft", "email": "draft", "maps": "read", "app-actions": "draft", "calls": "gated", "signature": "never"}'::jsonb
where slug = 'maintenance';
