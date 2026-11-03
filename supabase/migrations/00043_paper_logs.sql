-- Image Intelligence + Smart Maintenance, Phase 5 (design:
-- Trucking-Telegram-Image-Maintenance-Design-2026-11-02.md §6,
-- Migration C + chapter §7). Numbering: 00041 (Phase 1) and 00042
-- (Phases 3-4) precede it; 00043 is the next free number in this
-- program's run, re-checked against main at build time.
--
-- What this migration adds:
--   duty_logs.source - where a duty row came from: 'app' (logged
--     in the app or by Abel from conversation about the app's own
--     entries - the legacy default), 'paper_photo' (read off his
--     paper log sheet by the §7 pipeline), or 'conversation' (his
--     typed words filling a span the sheet read couldn't resolve).
--     Chapter §7's doctrine rides on this column: while he is on
--     paper, the paper is the legal record and the app is a
--     mirror - a paper_photo row is never silently rewritten, and
--     every correction to one carries the re-mark-your-paper
--     reminder. Existing rows default to 'app', which is what
--     they are.
--   duty_logs.source_document_id - for paper_photo rows, the
--     documents row of the sheet photograph itself: the app's
--     evidence copy, one tap from the HOS view, and the row whose
--     extracted_fields.paper_log_complete stamp says whether the
--     day was read in full (§7.5).
--
-- duty_logs already carries company_id + tenant-isolation RLS
-- (00011); this migration changes no policy.

alter table public.duty_logs
  add column if not exists source text not null default 'app';

alter table public.duty_logs
  drop constraint if exists duty_logs_source_check;
alter table public.duty_logs
  add constraint duty_logs_source_check
  check (source in ('app', 'paper_photo', 'conversation'));

alter table public.duty_logs
  add column if not exists source_document_id uuid references public.documents(id);

comment on column public.duty_logs.source is
  'Row provenance (Image Intelligence §7): app | paper_photo | conversation. Paper is the legal record while he runs paper logs; paper_photo rows are mirrors, corrected only through proposals carrying the re-mark reminder.';
comment on column public.duty_logs.source_document_id is
  'For source = paper_photo: the documents row of the log-sheet photograph this row was read from (the evidence copy; its extracted_fields.paper_log_complete says whether the day read in full).';
