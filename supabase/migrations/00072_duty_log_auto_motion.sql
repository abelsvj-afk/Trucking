-- 00072 - Block A (docs/design/driver-hud-round2.md): duty_logs.source gains
-- 'auto_motion' - a Driving row the app wrote itself because the truck was
-- detected moving for a sustained time while the log said otherwise. It is
-- provenance only: such a row starts at the DETECTION time and never rewrites
-- earlier segments. Existing rows and policies are untouched.

alter table public.duty_logs
  drop constraint if exists duty_logs_source_check;
alter table public.duty_logs
  add constraint duty_logs_source_check
  check (source in ('app', 'paper_photo', 'conversation', 'auto_motion'));

comment on column public.duty_logs.source is
  'Row provenance: app | paper_photo | conversation | auto_motion (the app switched to Driving from sustained detected motion; started_at = detection time).';
