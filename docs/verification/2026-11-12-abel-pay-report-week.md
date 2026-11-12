# Verification record - Abel's weekly pay report chose its week on the UTC calendar (2026-11-12)

Owner decision 2026-11-12: "Approved - fix first ... correct the Sunday-evening week-selection boundary". Branch
`fix/abel-pay-report-week`.

- **Defect:** `mondayOf()` in `src/services/bot/pay-report.ts` returned the Monday of the UTC week. From Sunday 7 PM Eastern
  (8 PM in summer) UTC is already Monday, so:
  - the `weekly_pay_report` tool's "this week" was the week that had not started (empty), and its default "last full week" was
    the week still in progress;
  - the scheduled report treated the Sunday still in progress as a finished week and could build it up to five hours early.
- **Fix:** `mondayOf()` takes the calendar day from `todayEastern()` (America/New_York) and does the weekday arithmetic on that
  day alone. One function changed; both callers (`pay-tools.ts` tool, `lastCompletedWeekStart()` for the scheduler) inherit it.
  No pay calculation, query or report text changed.
- **Behaviour after the fix, stated exactly:** the week is Monday 12:00 AM to Sunday 11:59 PM Eastern. On Sunday evening
  "this week" is the week ending tonight and "last full week" is the one before it. From Monday 12:00 AM Eastern, "last full
  week" is the week that just ended. The scheduled report therefore targets a week only after it has fully ended.
- **Reproduction test:** `tests/unit/services/bot/pay-report-week.test.ts` keeps the old UTC rule in the test and asserts it
  returns 2026-11-16 for Sunday Nov 15, 8:30 PM Eastern.
- **Regression tests (same file):** winter and summer time, the midnight-Eastern turn to the minute, both daylight-saving
  Sundays, a year boundary, and the scheduler's week. Against the unfixed function 3 of 7 FAIL; against the fix all 7 pass
  (both runs done 2026-11-12).
- **Left alone:** `summaries.weekStartOf` (an internal key, not shown to the driver) and Abel's rolling "last N days" filters.
  Listed in `docs/design/formatting-investigation-2026-11-12.md` on the notes branch.
- **Not verified:** the live bot. No message was sent; nothing was checked against production data.
